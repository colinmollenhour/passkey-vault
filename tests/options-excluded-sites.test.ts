/**
 * Settings lists the sites turned off from the vault's dialog in every
 * interception mode, and turns them back on through the background.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DOMAIN_RULES_KEY, EXCLUDED_SITES_KEY } from '../src/utils/domain-rules';
import { ExcludedSites } from '../src/background/excluded-sites';
import {
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  FakeChrome,
  type MessageSender,
  type StorageData,
} from './helpers/fake-chrome';

const chrome = new FakeChrome();
chrome.install();

const OPTIONS_PAGE: MessageSender = {
  id: EXTENSION_ID,
  url: `${EXTENSION_ORIGIN}/options.html`,
  origin: EXTENSION_ORIGIN,
  tab: { id: 3, url: `${EXTENSION_ORIGIN}/options.html` },
};
chrome.contentSender = () => OPTIONS_PAGE;

const SYNC_SERVICE = '../src/sync/sync-service';
const tick = () => new Promise<void>((done) => setTimeout(done, 0));
const settle = async () => {
  for (let i = 0; i < 25; i++) await tick();
  for (let i = 0; i < 2000 && chrome.pendingMessages > 0; i++) await tick();
  for (let i = 0; i < 25; i++) await tick();
};

/** Storage listeners of the open options page. */
const pageListeners: Array<Parameters<typeof chrome.api.storage.onChanged.addListener>[0]> = [];

/** A fresh background worker, and the options page loaded on `seed`. */
async function openOptions(seed: StorageData): Promise<void> {
  chrome.killWorker();
  chrome.local.seed(seed);
  chrome.sessionArea.seed({});
  chrome.sentToBackground.length = 0;
  chrome.startWorker(() => {
    jest.isolateModules(() => {
      jest.doMock(SYNC_SERVICE, () => ({
        syncService: {
          initialize: jest.fn(async () => undefined),
          disconnect: jest.fn(async () => undefined),
          requestSync: jest.fn(async () => undefined),
          broadcastPasskeyUpdate: jest.fn(async () => undefined),
          retryPending: jest.fn(),
          getStatus: jest.fn(() => ({ connected: false, lastError: null })),
          getDebugInfo: jest.fn(() => ({})),
          getDebugLogs: jest.fn(() => []),
          clearDebugLogs: jest.fn(),
        },
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../src/background/background');
    });
  });
  await settle();

  // The previous test's page goes away with its listeners.
  for (const listener of pageListeners.splice(0)) {
    chrome.api.storage.onChanged.removeListener(listener);
  }
  document.documentElement.innerHTML = readFileSync(resolve('src/ui/options.html'), 'utf8');
  const onLoad = jest.spyOn(document, 'addEventListener');
  const onChanged = jest.spyOn(chrome.api.storage.onChanged, 'addListener');
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../src/ui/options');
  });
  const ready = onLoad.mock.calls.find(([type]) => type === 'DOMContentLoaded')![1] as () => void;
  document.removeEventListener('DOMContentLoaded', ready);
  onLoad.mockRestore();
  ready();
  await settle();
  pageListeners.push(...onChanged.mock.calls.map(([listener]) => listener));
  onChanged.mockRestore();
}

const card = () => document.getElementById('excluded-sites-card') as HTMLElement;
const empty = () => document.getElementById('excluded-sites-empty') as HTMLElement;
const listed = () =>
  Array.from(document.querySelectorAll('#excluded-sites-list .domain-item span')).map(
    (span) => span.textContent
  );
const removeButton = (site: string) =>
  Array.from(
    document.querySelectorAll<HTMLButtonElement>('#excluded-sites-list button[data-site]')
  ).find((button) => button.dataset.site === site)!;
const modeRadio = (mode: string) =>
  document.querySelector(`input[name="interception-mode"][value="${mode}"]`) as HTMLInputElement;

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

beforeEach(() => {
  window.alert = jest.fn();
});

describe('options: sites where the vault is off', () => {
  it.each(['disabled', 'all', 'allowlist', 'blocklist'])('lists them in mode %s', async (mode) => {
    await openOptions({
      [DOMAIN_RULES_KEY]: { mode, domains: ['example.com'] },
      [EXCLUDED_SITES_KEY]: ['login.example.com', 'shop.example'],
    });

    expect(card().style.display).not.toBe('none');
    expect(listed()).toEqual(['login.example.com', 'shop.example']);
    expect(empty().style.display).toBe('none');
  });

  it('says when there are none', async () => {
    await openOptions({});

    expect(listed()).toEqual([]);
    expect(empty().style.display).toBe('block');
  });

  it('turns a site back on through the background', async () => {
    await openOptions({ [EXCLUDED_SITES_KEY]: ['login.example.com', 'shop.example'] });

    removeButton('login.example.com').click();
    await settle();

    expect(chrome.local.data[EXCLUDED_SITES_KEY]).toEqual(['shop.example']);
    expect(listed()).toEqual(['shop.example']);
    const sent = chrome.sentToBackground.filter(
      ({ message }) => message.type === 'EXCLUDED_SITES_REMOVE'
    );
    expect(sent.map(({ message }) => message.payload)).toEqual([{ rpId: 'login.example.com' }]);
    expect(sent[0].sender.url).toBe(OPTIONS_PAGE.url);
  });

  it('shows a change that arrives before the removal’s answer, not the older answer', async () => {
    await openOptions({ [EXCLUDED_SITES_KEY]: ['login.example.com', 'shop.example'] });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const send = chrome.api.runtime.sendMessage;
    const answer = jest
      .spyOn(chrome.api.runtime, 'sendMessage')
      .mockImplementation(async (message: unknown) => {
        const response = await send(message);
        await held;
        return response;
      });

    removeButton('login.example.com').click();
    await settle();
    expect(chrome.local.data[EXCLUDED_SITES_KEY]).toEqual(['shop.example']);
    // The vault dialog turns another site off before the answer arrives.
    await new ExcludedSites().add('new.example');
    await settle();
    release();
    await settle();
    answer.mockRestore();

    expect(listed()).toEqual(['shop.example', 'new.example']);
    expect(window.alert).not.toHaveBeenCalled();
  });

  it('keeps the site and says so when the background cannot remove it', async () => {
    await openOptions({ [EXCLUDED_SITES_KEY]: ['shop.example'] });
    chrome.faults.push({
      op: 'set',
      times: 1,
      match: (keys) => keys.includes(EXCLUDED_SITES_KEY),
    });

    removeButton('shop.example').click();
    await settle();

    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('shop.example'));
    expect(listed()).toEqual(['shop.example']);
    expect(removeButton('shop.example').disabled).toBe(false);
    chrome.faults.length = 0;
  });

  it('shows a site the vault dialog turns off while the page is open', async () => {
    await openOptions({});

    await new ExcludedSites().add('new.example');
    await settle();

    expect(listed()).toEqual(['new.example']);
    expect(empty().style.display).toBe('none');
  });

  it('follows interception rules changed elsewhere', async () => {
    await openOptions({ [DOMAIN_RULES_KEY]: { mode: 'all', domains: [] } });

    await chrome.local.set({
      [DOMAIN_RULES_KEY]: {
        mode: 'blocklist',
        domains: ['a.example'],
        passthroughOnNoPasskey: false,
      },
    });
    await settle();

    expect(modeRadio('blocklist').checked).toBe(true);
    expect(document.getElementById('domain-list-card')!.style.display).toBe('block');
    expect(document.querySelector('#domain-list .domain-item span')?.textContent).toBe('a.example');
    expect(
      (document.getElementById('passthrough-missing-toggle') as HTMLInputElement).checked
    ).toBe(false);
  });

  it('saves the fallback choice the user clicked, even if a change re-renders it meanwhile', async () => {
    await openOptions({ [DOMAIN_RULES_KEY]: { mode: 'all', domains: [] } });
    const toggle = document.getElementById('passthrough-missing-toggle') as HTMLInputElement;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const local = chrome.api.storage.local;
    const get = local.get.bind(local);
    const reading = jest.spyOn(local, 'get').mockImplementation(async (keys: unknown) => {
      const result = await get(keys as never);
      await held;
      return result;
    });

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await settle();
    // Another Settings page changes the rules while this one reads them.
    const elsewhere = { mode: 'blocklist', domains: ['a.example'], passthroughOnNoPasskey: true };
    for (const listener of pageListeners) {
      listener({ [DOMAIN_RULES_KEY]: { newValue: elsewhere } }, 'local');
    }
    expect(toggle.checked).toBe(true);
    release();
    await settle();
    reading.mockRestore();

    expect(chrome.local.data[DOMAIN_RULES_KEY]).toMatchObject({ passthroughOnNoPasskey: false });
  });

  describe('keeping a keyboard user’s place', () => {
    const focusRemove = (site: string) => {
      removeButton(site).focus();
      expect(document.activeElement).toBe(removeButton(site));
    };

    it('moves focus to the row that took the removed one’s place', async () => {
      await openOptions({ [EXCLUDED_SITES_KEY]: ['a.example', 'b.example', 'c.example'] });
      focusRemove('a.example');

      removeButton('a.example').click();
      await settle();

      expect(listed()).toEqual(['b.example', 'c.example']);
      expect(document.activeElement).toBe(removeButton('b.example'));
    });

    it('moves focus to the row above when the last one goes', async () => {
      await openOptions({ [EXCLUDED_SITES_KEY]: ['a.example', 'b.example'] });
      focusRemove('b.example');

      removeButton('b.example').click();
      await settle();

      expect(document.activeElement).toBe(removeButton('a.example'));
    });

    it('moves focus to the empty hint when the list empties', async () => {
      await openOptions({ [EXCLUDED_SITES_KEY]: ['a.example'] });
      focusRemove('a.example');

      removeButton('a.example').click();
      await settle();

      expect(document.activeElement).toBe(empty());
    });

    it('keeps the place when disabling the button took focus from it', async () => {
      // Browsers move focus off a button that becomes disabled.
      await openOptions({ [EXCLUDED_SITES_KEY]: ['a.example', 'b.example'] });
      focusRemove('a.example');
      const button = removeButton('a.example');
      const disabled = Object.getOwnPropertyDescriptor(HTMLButtonElement.prototype, 'disabled')!;
      Object.defineProperty(button, 'disabled', {
        configurable: true,
        get: () => disabled.get!.call(button),
        set: (value: boolean) => {
          disabled.set!.call(button, value);
          if (value) button.blur();
        },
      });

      button.click();
      await settle();

      expect(document.activeElement).toBe(removeButton('b.example'));
    });

    it('keeps the focused row when another site changes', async () => {
      await openOptions({ [EXCLUDED_SITES_KEY]: ['a.example', 'b.example'] });
      focusRemove('b.example');

      await new ExcludedSites().add('c.example');
      await settle();

      expect(document.activeElement).toBe(removeButton('b.example'));
    });

    it('leaves focus alone when it is elsewhere on the page', async () => {
      await openOptions({ [EXCLUDED_SITES_KEY]: ['a.example'] });
      const other = modeRadio('all');
      other.focus();

      await new ExcludedSites().add('c.example');
      await settle();

      expect(document.activeElement).toBe(other);
    });
  });

  it('shows a stored site as text, not markup', async () => {
    await openOptions({ [EXCLUDED_SITES_KEY]: ['<img src=x onerror=alert(1)>'] });

    expect(document.querySelector('#excluded-sites-list img')).toBeNull();
    expect(listed()).toEqual(['<img src=x onerror=alert(1)>']);
  });
});
