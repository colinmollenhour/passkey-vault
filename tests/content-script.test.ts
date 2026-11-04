/**
 * The content script sits between the page shim and the background worker.
 * These tests drive it the way the shim does (window.postMessage) with the
 * background, the vault dialog's frame and the in-page notices mocked, and
 * read back what it posts to the page.
 */

// A module, not a global script: other test files declare the same top-level
// names, and TypeScript would reject the clash when both compile in one worker.
export {};

import { trustedKey } from './helpers/trusted-input';
import { HANDOFF_FOCUS_WAIT_MS, whenFocused } from '../src/content/vault-dialog-client';

const PAGE_SOURCE = 'PASSKEY_VAULT_PAGE';
const CONTENT_SOURCE = 'PASSKEY_VAULT_CONTENT';

/** Whether dialogs open in a frame (Chrome) or in a window (Firefox). */
let mockFrameDialogs = true;
jest.mock('../src/content/vault-dialog-frame', () => ({
  extensionOrigin: () => 'chrome-extension://test',
  supportsFrameDialogs: () => mockFrameDialogs,
  mountDialogFrame: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mountDialogFrame } = require('../src/content/vault-dialog-frame') as {
  mountDialogFrame: jest.Mock;
};

jest.mock('../src/content/page-notices', () => ({
  showPasskeyCreatedNotification: jest.fn(),
  showPasskeyUsedNotification: jest.fn(),
  showErrorNotification: jest.fn(),
  showInfoNotification: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ui = require('../src/content/page-notices') as Record<string, jest.Mock>;

type BackgroundHandler = (message: { type: string; payload?: unknown }) => unknown;
let background: BackgroundHandler = () => ({ success: true });
let domainRules: Record<string, unknown> = {};
let excludedSites: unknown = undefined;
/** RP IDs the background says this page may not use. */
let refusedRpIds: string[] = [];

const chromeMock = (window as unknown as { chrome: Record<string, any> }).chrome;
// The background decides which RP IDs the page may use; these tests are about
// what happens after it says yes.
chromeMock.runtime.sendMessage.mockImplementation(
  async (message: { type: string; payload?: { rpId?: string } }) =>
    message.type === 'CHECK_RP_ID'
      ? { allowed: !refusedRpIds.includes(message.payload?.rpId ?? '') }
      : background(message)
);
chromeMock.storage.local.get.mockImplementation(async (keys: string | string[]) => {
  const stored: Record<string, unknown> = {
    domain_rules: domainRules,
    ...(excludedSites !== undefined && { excluded_sites: excludedSites }),
  };
  return Object.fromEntries(
    ([] as string[])
      .concat(keys)
      .filter((key) => key in stored)
      .map((key) => [key, stored[key]])
  );
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Post a request as the page shim does and wait for the content script's answer. */
function request(type: string, payload: Record<string, unknown>): Promise<any> {
  const requestId = `req_${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const listener = (event: MessageEvent) => {
      if (event.data?.source !== CONTENT_SOURCE || event.data.requestId !== requestId) {
        return;
      }
      window.removeEventListener('message', listener);
      resolve(event.data.result);
    };
    window.addEventListener('message', listener);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: PAGE_SOURCE, type, payload, requestId },
        source: window,
      })
    );
  });
}

function getRequest() {
  return request('PASSKEY_GET_REQUEST', {
    publicKey: { rpId: 'localhost', challenge: 'AQID' },
    origin: 'http://localhost',
  });
}

/** The content script's chrome.runtime.onMessage listeners. */
let backgroundListeners: Array<(...args: unknown[]) => void> = [];

beforeAll(async () => {
  require('../src/content/content');
  // initialize() awaits i18n and logger set-up before it listens to the page.
  await flush();
  backgroundListeners = chromeMock.runtime.onMessage.addListener.mock.calls.map(
    ([listener]: [(...args: unknown[]) => void]) => listener
  );
});

/** Tell the content script how a dialog ended, as the background does. */
function dialogResult(dialogId: string, outcome: string): void {
  for (const listener of backgroundListeners) {
    listener(
      { type: 'PASSKEY_DIALOG_RESULT', dialogId, outcome },
      { id: chromeMock.runtime.id },
      () => undefined
    );
  }
}

let frame: { gone: Promise<void>; unmount: jest.Mock; remove: () => void };

beforeEach(() => {
  jest.clearAllMocks();
  domainRules = {};
  excludedSites = undefined;
  refusedRpIds = [];
  mockFrameDialogs = true;
  mountDialogFrame.mockImplementation(() => {
    let remove!: () => void;
    const gone = new Promise<void>((resolve) => (remove = resolve));
    frame = { gone, unmount: jest.fn(), remove };
    return frame;
  });
});

describe('content script: sign-in with a locked vault', () => {
  const locked = {
    success: false,
    error: 'Secure storage is locked. Please unlock with master password.',
    code: 'VAULT_LOCKED',
  };

  beforeEach(() => {
    background = (message) => (message.type === 'PASSKEY_DIALOG_OPEN' ? locked : {});
  });

  it('says the vault is locked instead of "no passkey", then falls back to native', async () => {
    const result = await getRequest();

    expect(result.passthrough).toBe(true);
    expect(result.error).toBe('Vault is locked');
    expect(ui.showErrorNotification).toHaveBeenCalledWith(
      'Vault Locked',
      expect.stringContaining('Unlock Fenko Vault')
    );
    expect(mountDialogFrame).not.toHaveBeenCalled();
  });

  it('blocks with the locked message when native fallback is turned off', async () => {
    domainRules = { passthroughOnNoPasskey: false };

    const result = await getRequest();

    expect(result.passthrough).toBeUndefined();
    expect(result.blockNativeFallback).toBe(true);
    expect(result.error).toContain('Unlock Fenko Vault');
    expect(result.error).not.toBe('No passkeys found for this site');
  });

  it('still treats an unlocked, empty vault as having no passkey', async () => {
    background = (message) =>
      message.type === 'PASSKEY_DIALOG_OPEN' ? { success: true, status: 'none' } : {};

    const result = await getRequest();

    expect(result.passthrough).toBe(true);
    expect(result.error).toBe('No vault passkey for this site');
    expect(ui.showErrorNotification).not.toHaveBeenCalled();
  });
});

describe('content script: page cancels an in-flight request', () => {
  /** Post a request and return its id without waiting for an answer. */
  function post(type: string, payload: Record<string, unknown>): string {
    const requestId = `req_${Math.random().toString(36).slice(2)}`;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: PAGE_SOURCE, type, payload, requestId },
        source: window,
      })
    );
    return requestId;
  }

  function cancel(requestId: string): void {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: PAGE_SOURCE, type: 'PASSKEY_CANCEL_REQUEST', requestId },
        source: window,
      })
    );
  }

  let posted: unknown[];
  const record = (event: MessageEvent) => {
    if (event.data?.source === CONTENT_SOURCE) posted.push(event.data);
  };

  beforeEach(() => {
    posted = [];
    window.addEventListener('message', record);
    background = (message) =>
      message.type === 'PASSKEY_DIALOG_OPEN'
        ? { success: true, status: 'open', dialogId: 'dialog-1', token: 'token-1' }
        : { success: true, credential: { id: 'cred-1', response: {} } };
  });

  afterEach(() => {
    window.removeEventListener('message', record);
  });

  const sentTypes = () =>
    chromeMock.runtime.sendMessage.mock.calls.map(([message]: [{ type: string }]) => message.type);

  it('closes the create dialog, and a confirmation that arrives late never creates', async () => {
    const requestId = post('PASSKEY_CREATE_REQUEST', {
      publicKey: {
        rp: { id: 'localhost' },
        user: { name: 'alice' },
        challenge: 'AQID',
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      },
    });
    await flush();
    expect(mountDialogFrame).toHaveBeenCalledWith({
      token: 'token-1',
      kind: 'create',
      focus: true,
    });

    cancel(requestId);
    // The click that raced the cancel still loses.
    dialogResult('dialog-1', 'approved');
    await flush();

    expect(frame.unmount).toHaveBeenCalled();
    expect(sentTypes()).toContain('PASSKEY_DIALOG_CANCEL');
    expect(sentTypes()).not.toContain('CREATE_PASSKEY');
    expect(ui.showPasskeyCreatedNotification).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it('closes the picker, and a decision that arrives late never signs', async () => {
    const requestId = post('PASSKEY_GET_REQUEST', {
      publicKey: { rpId: 'localhost', challenge: 'AQID' },
    });
    await flush();
    expect(mountDialogFrame).toHaveBeenCalledWith({ token: 'token-1', kind: 'get', focus: true });

    cancel(requestId);
    // The click that raced the cancel still loses.
    dialogResult('dialog-1', 'approved');
    await flush();

    expect(frame.unmount).toHaveBeenCalled();
    expect(sentTypes()).toContain('PASSKEY_DIALOG_CANCEL');
    expect(sentTypes()).not.toContain('GET_PASSKEY');
    expect(posted).toEqual([]);
  });
});

describe('content script: the vault dialog', () => {
  let posted: any[];
  const record = (event: MessageEvent) => {
    if (event.data?.source === CONTENT_SOURCE) posted.push(event.data);
  };
  const sent = () =>
    chromeMock.runtime.sendMessage.mock.calls.map(([message]: [Record<string, any>]) => message);

  beforeEach(() => {
    posted = [];
    window.addEventListener('message', record);
    background = (message) =>
      message.type === 'PASSKEY_DIALOG_OPEN'
        ? { success: true, status: 'open', dialogId: 'dialog-2', token: 'token-2' }
        : { success: true, credential: { id: 'cred-1', response: {} } };
  });

  afterEach(() => window.removeEventListener('message', record));

  it('signs after the dialog approves, naming no passkey itself', async () => {
    const result = getRequest();
    await flush();

    dialogResult('dialog-2', 'approved');
    const answer = await result;

    expect(answer.success).toBe(true);
    const getPasskey = sent().find((message) => message.type === 'GET_PASSKEY');
    expect(getPasskey.payload).not.toHaveProperty('selectedPasskeyId');
    expect(frame.unmount).toHaveBeenCalled();
  });

  it('ignores an outcome for a dialog it is not showing', async () => {
    const result = getRequest();
    await flush();

    dialogResult('someone-elses-dialog', 'approved');
    await flush();
    expect(sent().map((message) => message.type)).not.toContain('GET_PASSKEY');

    dialogResult('dialog-2', 'cancel');
    expect((await result).name).toBe('NotAllowedError');
  });

  it('treats the page removing the frame as a cancel', async () => {
    const result = getRequest();
    await flush();

    frame.remove();
    const answer = await result;

    expect(answer).toMatchObject({ success: false, name: 'NotAllowedError' });
    expect(sent().map((message) => message.type)).toContain('PASSKEY_DIALOG_CANCEL');
  });

  it('cancels on Escape in the page, but not on an Escape the page made up', async () => {
    const result = getRequest();
    await flush();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(frame.unmount).not.toHaveBeenCalled();

    trustedKey(document, 'Escape');
    expect((await result).name).toBe('NotAllowedError');
  });

  it('hands the request to the browser when the user picks another passkey', async () => {
    const result = getRequest();
    await flush();

    dialogResult('dialog-2', 'passthrough');

    expect(await result).toMatchObject({ passthrough: true, error: 'User chose other passkey' });
  });

  it('drops the frame when the dialog moves to a window, and goes on waiting', async () => {
    const result = getRequest();
    await flush();

    dialogResult('dialog-2', 'escalated');
    await flush();
    expect(frame.unmount).toHaveBeenCalled();
    expect(sent().map((message) => message.type)).not.toContain('PASSKEY_DIALOG_CANCEL');

    dialogResult('dialog-2', 'approved');
    expect((await result).success).toBe(true);
  });

  it('tells the dialog the top page’s pixel ratio, from the top frame only', () => {
    const answers: unknown[] = [];
    for (const listener of backgroundListeners) {
      listener(
        { type: 'PASSKEY_VAULT_TOP_METRICS' },
        { id: chromeMock.runtime.id },
        (answer: unknown) => answers.push(answer)
      );
    }

    expect(answers).toEqual([{ dpr: window.devicePixelRatio }]);
  });

  it('replaces its dialog when the page asks again', async () => {
    const first = getRequest();
    await flush();
    const firstFrame = frame;

    void getRequest();
    await flush();

    expect((await first).name).toBe('NotAllowedError');
    expect(firstFrame.unmount).toHaveBeenCalled();
    expect(mountDialogFrame).toHaveBeenCalledTimes(2);
  });

  it('passes a dismissed autofill picker to the browser’s own autofill', async () => {
    const result = request('PASSKEY_GET_REQUEST', {
      publicKey: { rpId: 'localhost', challenge: 'AQID' },
      mediation: 'conditional',
    });
    await flush();

    dialogResult('dialog-2', 'cancel');

    expect(await result).toMatchObject({ passthrough: true, error: 'Vault picker dismissed' });
  });

  it('hands the request to the browser when the user turns the vault off for the site', async () => {
    const result = getRequest();
    await flush();

    dialogResult('dialog-2', 'excluded');

    expect(await result).toMatchObject({ passthrough: true, error: 'Site excluded' });
    // The background tells the top frame to show the notice.
    expect(ui.showInfoNotification).not.toHaveBeenCalled();
    expect(sent().map((message) => message.type)).not.toContain('GET_PASSKEY');
  });

  it('opens a conditional sign-in without taking focus from the page', async () => {
    void request('PASSKEY_GET_REQUEST', {
      publicKey: { rpId: 'localhost', challenge: 'AQID' },
      mediation: 'conditional',
    });
    await flush();

    expect(mountDialogFrame).toHaveBeenCalledWith(expect.objectContaining({ focus: false }));
  });
});

describe('content script: the create confirmation', () => {
  let posted: any[];
  const record = (event: MessageEvent) => {
    if (event.data?.source === CONTENT_SOURCE) posted.push(event.data);
  };
  const sentTypes = () =>
    chromeMock.runtime.sendMessage.mock.calls.map(([message]: [{ type: string }]) => message.type);

  function createRequest() {
    return request('PASSKEY_CREATE_REQUEST', {
      publicKey: {
        rp: { id: 'localhost' },
        user: { name: 'alice' },
        challenge: 'AQID',
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      },
    });
  }

  beforeEach(() => {
    posted = [];
    window.addEventListener('message', record);
    background = (message) =>
      message.type === 'PASSKEY_DIALOG_OPEN'
        ? { success: true, status: 'open', dialogId: 'dialog-3', token: 'token-3' }
        : { success: true, credential: { id: 'cred-1', response: {} } };
  });

  afterEach(() => window.removeEventListener('message', record));

  it('hands the request to the browser on "Use another device", creating nothing', async () => {
    const result = createRequest();
    await flush();

    dialogResult('dialog-3', 'passthrough');

    const answer = await result;
    expect(answer).toMatchObject({ passthrough: true, error: 'User chose another device' });
    expect(answer.blockNativeFallback).toBeUndefined();
    expect(sentTypes()).not.toContain('CREATE_PASSKEY');
    expect(ui.showErrorNotification).not.toHaveBeenCalled();
  });

  it('hands the request to the browser when the user turns the vault off here', async () => {
    const result = createRequest();
    await flush();

    dialogResult('dialog-3', 'excluded');

    expect(await result).toMatchObject({ passthrough: true, error: 'Site excluded' });
    expect(sentTypes()).not.toContain('CREATE_PASSKEY');
    expect(ui.showInfoNotification).not.toHaveBeenCalled();
  });

  it('still refuses, and keeps the browser out, on Cancel', async () => {
    const result = createRequest();
    await flush();

    dialogResult('dialog-3', 'cancel');

    expect(await result).toMatchObject({
      success: false,
      name: 'NotAllowedError',
      blockNativeFallback: true,
    });
    expect(sentTypes()).not.toContain('CREATE_PASSKEY');
  });
});

describe('content script: a site the user turned the vault off for', () => {
  beforeEach(() => {
    background = () => ({ success: true, status: 'open', dialogId: 'dialog-4', token: 't' });
  });

  it.each([
    ['sign-in', () => getRequest()],
    [
      'registration',
      () =>
        request('PASSKEY_CREATE_REQUEST', {
          publicKey: {
            rp: { id: 'localhost' },
            user: { name: 'alice' },
            challenge: 'AQID',
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          },
        }),
    ],
  ])('leaves a %s to the browser without opening a dialog', async (_label, run) => {
    // Whatever the mode says, and a list left over from another mode stays off.
    domainRules = { mode: 'all', domains: ['localhost'] };
    excludedSites = ['localhost'];

    const answer = await run();

    expect(answer).toMatchObject({ passthrough: true, error: 'Domain not intercepted' });
    expect(mountDialogFrame).not.toHaveBeenCalled();
    expect(
      chromeMock.runtime.sendMessage.mock.calls.map(([message]: [{ type: string }]) => message.type)
    ).not.toContain('PASSKEY_DIALOG_OPEN');
  });

  it.each<[string, Record<string, unknown>, unknown]>([
    ['turned off from the dialog', { mode: 'all', domains: [] }, ['bank.example']],
    ['on the block list', { mode: 'blocklist', domains: ['bank.example'] }, undefined],
    ['off the allow list', { mode: 'allowlist', domains: ['shop.example'] }, undefined],
  ])(
    'tells a page asking about another site nothing about whether it is %s',
    async (_label, rules, excluded) => {
      // A page can name any RP ID and read the reason it gets back.
      refusedRpIds = ['bank.example', 'shop.example'];
      domainRules = rules;
      excludedSites = excluded;
      const ask = (rpId: string) =>
        request('PASSKEY_GET_REQUEST', { publicKey: { rpId, challenge: 'AQID' } });

      const listed = await ask('bank.example');
      const notListed = await ask('shop.example');

      expect(listed).toEqual(notListed);
      expect(listed).toMatchObject({ passthrough: true, error: 'RP ID not valid here' });
    }
  );

  describe('the notice the background sends once a site is turned off', () => {
    /** Send it as the background does; returns what this frame answered. */
    const fromBackground = (sender: unknown, message: Record<string, unknown>) => {
      const answers: unknown[] = [];
      for (const listener of backgroundListeners) {
        listener({ type: 'PASSKEY_VAULT_SITE_EXCLUDED', ...message }, sender, (answer: unknown) =>
          answers.push(answer)
        );
      }
      return answers;
    };
    const extension = { id: chromeMock.runtime.id };

    it('is shown by the page that asked, which says so', () => {
      const answers = fromBackground(extension, {
        rpId: 'localhost',
        origin: window.location.origin,
      });

      expect(answers).toEqual([{ shown: true }]);
      expect(ui.showInfoNotification).toHaveBeenCalledWith(
        'Turned Off Here',
        expect.stringContaining('passkeys on localhost.')
      );
    });

    it('is not shown by a page of another site, an embedder or one navigated to', () => {
      const answers = fromBackground(extension, {
        rpId: 'bank.example',
        origin: 'https://bank.example',
      });

      expect(answers).toEqual([{ shown: false }]);
      expect(ui.showInfoNotification).not.toHaveBeenCalled();
    });

    it('is ignored from anyone but the extension, or without a site', () => {
      fromBackground({ id: 'another-extension' }, { rpId: 'localhost', origin: 'x' });
      fromBackground(extension, { rpId: 42, origin: window.location.origin });

      expect(ui.showInfoNotification).not.toHaveBeenCalled();
    });
  });

  it('still handles other sites, a parent of an excluded host included', async () => {
    excludedSites = ['example.com', 'login.localhost'];
    domainRules = { mode: 'blocklist', domains: [] };

    const result = getRequest();
    await flush();

    expect(mountDialogFrame).toHaveBeenCalledTimes(1);
    dialogResult('dialog-4', 'cancel');
    expect((await result).name).toBe('NotAllowedError');
  });
});

describe('content script: handing a request to the browser from a dialog window', () => {
  let posted: any[];
  const record = (event: MessageEvent) => {
    if (event.data?.source === CONTENT_SOURCE) posted.push(event.data);
  };
  let focused: jest.SpyInstance;

  beforeEach(() => {
    posted = [];
    window.addEventListener('message', record);
    mockFrameDialogs = false;
    // The background opened the dialog in a window, which has focus.
    focused = jest.spyOn(document, 'hasFocus').mockReturnValue(false);
    background = (message) =>
      message.type === 'PASSKEY_DIALOG_OPEN'
        ? { success: true, status: 'open', dialogId: 'dialog-5' }
        : { success: true };
  });

  afterEach(() => {
    window.removeEventListener('message', record);
    focused.mockRestore();
  });

  it('waits for the page to have focus again, as the browser requires', async () => {
    const result = getRequest();
    await flush();

    dialogResult('dialog-5', 'passthrough');
    await flush();
    expect(posted).toEqual([]);

    focused.mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));

    expect(await result).toMatchObject({ passthrough: true, error: 'User chose other passkey' });
  });

  it('does not wait to refuse a request the user cancelled', async () => {
    const result = getRequest();
    await flush();

    dialogResult('dialog-5', 'cancel');

    expect(await result).toMatchObject({ name: 'NotAllowedError', blockNativeFallback: true });
  });
});

describe('waiting for focus', () => {
  let focused: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    focused = jest.spyOn(document, 'hasFocus').mockReturnValue(false);
  });

  afterEach(() => {
    focused.mockRestore();
    jest.useRealTimers();
  });

  /** Whether the wait is over, after letting promise callbacks run. */
  async function over(wait: Promise<void>): Promise<boolean> {
    let done = false;
    void wait.then(() => (done = true));
    for (let i = 0; i < 3; i++) await Promise.resolve();
    return done;
  }

  it('is over at once for a page that has focus', async () => {
    focused.mockReturnValue(true);

    expect(await over(whenFocused(new AbortController().signal))).toBe(true);
  });

  it('ends when the page gets focus', async () => {
    const wait = whenFocused(new AbortController().signal);
    expect(await over(wait)).toBe(false);

    focused.mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));

    expect(await over(wait)).toBe(true);
  });

  it('goes on through a focus event the page dispatches without having focus', async () => {
    const wait = whenFocused(new AbortController().signal);

    window.dispatchEvent(new Event('focus'));

    expect(await over(wait)).toBe(false);
    // Focus that comes back after it still ends the wait.
    focused.mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    expect(await over(wait)).toBe(true);
  });

  it('gives up after a while, so the request still goes on', async () => {
    const wait = whenFocused(new AbortController().signal);

    jest.advanceTimersByTime(HANDOFF_FOCUS_WAIT_MS - 1);
    expect(await over(wait)).toBe(false);
    jest.advanceTimersByTime(1);

    expect(await over(wait)).toBe(true);
  });

  it('ends when the page gives up on the request', async () => {
    const controller = new AbortController();
    const wait = whenFocused(controller.signal);

    controller.abort();

    expect(await over(wait)).toBe(true);
  });
});
