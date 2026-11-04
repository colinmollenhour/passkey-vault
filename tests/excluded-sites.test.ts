/**
 * The background's list of sites the user turned the vault off for: one
 * writer, so a site added from the vault's dialog and one removed in
 * Settings cannot overwrite each other, and only Settings may remove one.
 */

import { ExcludedSites } from '../src/background/excluded-sites';
import { EXCLUDED_SITES_KEY } from '../src/utils/domain-rules';
import {
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  FakeChrome,
  type MessageSender,
} from './helpers/fake-chrome';

const chrome = new FakeChrome();
chrome.install();

const stored = () => chrome.local.data[EXCLUDED_SITES_KEY];

/** Count writes of the list, without changing what they do. */
function countWrites(): { count: number } {
  const counter = { count: 0 };
  const set = chrome.local.set.bind(chrome.local);
  jest.spyOn(chrome.local, 'set').mockImplementation(async (items) => {
    if (EXCLUDED_SITES_KEY in items) counter.count += 1;
    return set(items);
  });
  return counter;
}

beforeEach(() => {
  jest.restoreAllMocks();
  chrome.faults.length = 0;
  chrome.local.seed({});
});

describe('ExcludedSites', () => {
  it('adds a normalized RP ID once', async () => {
    const sites = new ExcludedSites();
    const counter = countWrites();

    expect(await sites.add(' Login.Example.COM ')).toEqual(['login.example.com']);
    expect(await sites.add('login.example.com')).toEqual(['login.example.com']);

    expect(stored()).toEqual(['login.example.com']);
    expect(counter.count).toBe(1);
  });

  it('removes an RP ID, and removing one that is not there changes nothing', async () => {
    chrome.local.seed({ [EXCLUDED_SITES_KEY]: ['a.example', 'b.example'] });
    const sites = new ExcludedSites();
    const counter = countWrites();

    expect(await sites.remove('A.example')).toEqual(['b.example']);
    expect(await sites.remove('c.example')).toEqual(['b.example']);

    expect(stored()).toEqual(['b.example']);
    expect(counter.count).toBe(1);
  });

  it('does not write an empty list when there was none', async () => {
    const counter = countWrites();

    expect(await new ExcludedSites().remove('a.example')).toEqual([]);

    expect(stored()).toBeUndefined();
    expect(counter.count).toBe(0);
  });

  it('refuses an empty RP ID without writing', async () => {
    const sites = new ExcludedSites();
    const counter = countWrites();

    await expect(sites.add('   ')).rejects.toThrow('An RP ID is required');
    await expect(sites.remove('')).rejects.toThrow('An RP ID is required');
    await expect(sites.add(undefined as unknown as string)).rejects.toThrow();

    expect(counter.count).toBe(0);
  });

  it('applies overlapping changes one after another', async () => {
    const sites = new ExcludedSites();

    await Promise.all([
      sites.add('a.example'),
      sites.add('b.example'),
      sites.remove('a.example'),
      sites.add('c.example'),
    ]);

    expect(stored()).toEqual(['b.example', 'c.example']);
  });

  it('fails the change whose write failed, and keeps applying later ones', async () => {
    chrome.faults.push({ op: 'set', times: 1, error: new Error('QUOTA_BYTES quota exceeded') });
    const sites = new ExcludedSites();

    const failed = sites.add('a.example');
    const next = sites.add('b.example');

    await expect(failed).rejects.toThrow('QUOTA_BYTES');
    expect(await next).toEqual(['b.example']);
    expect(stored()).toEqual(['b.example']);
  });

  it('fails a change whose read failed, and keeps applying later ones', async () => {
    chrome.faults.push({ op: 'get', times: 1 });
    const sites = new ExcludedSites();

    await expect(sites.add('a.example')).rejects.toThrow();
    expect(await sites.add('b.example')).toEqual(['b.example']);
  });

  it('cleans up a stored list that is not in normal form when it changes it', async () => {
    chrome.local.seed({ [EXCLUDED_SITES_KEY]: ['A.example', 'a.example', 7, ''] });
    const sites = new ExcludedSites();

    expect(await sites.list()).toEqual(['a.example']);
    expect(await sites.add('a.example')).toEqual(['a.example']);
    expect(stored()).toEqual(['a.example']);
  });
});

describe('background: EXCLUDED_SITES_REMOVE', () => {
  const SYNC_SERVICE = '../src/sync/sync-service';

  const OPTIONS_PAGE: MessageSender = {
    id: EXTENSION_ID,
    url: `${EXTENSION_ORIGIN}/options.html`,
    origin: EXTENSION_ORIGIN,
    tab: { id: 3, url: `${EXTENSION_ORIGIN}/options.html` },
  };
  const WEB_PAGE: MessageSender = {
    id: EXTENSION_ID,
    url: 'https://example.com/login',
    origin: 'https://example.com',
    tab: { id: 9, url: 'https://example.com/login' },
    frameId: 0,
  };
  /** The vault's dialog page, framed in the web page's tab. */
  const DIALOG_FRAME: MessageSender = {
    id: EXTENSION_ID,
    url: `${EXTENSION_ORIGIN}/vault-dialog.html`,
    origin: EXTENSION_ORIGIN,
    tab: WEB_PAGE.tab,
    frameId: 4,
  };
  /** The vault's dialog page, in a window of its own. */
  const DIALOG_WINDOW: MessageSender = {
    id: EXTENSION_ID,
    url: `${EXTENSION_ORIGIN}/vault-dialog.html#token`,
    origin: EXTENSION_ORIGIN,
    tab: { id: 600, url: `${EXTENSION_ORIGIN}/vault-dialog.html#token` },
    frameId: 0,
  };

  const send = (message: Record<string, unknown>, sender: MessageSender = OPTIONS_PAGE) =>
    chrome.deliver(message, sender) as Promise<any>;
  const remove = (rpId: unknown, sender?: MessageSender) =>
    send({ type: 'EXCLUDED_SITES_REMOVE', payload: { rpId } }, sender);
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  async function startWorker(): Promise<void> {
    chrome.killWorker();
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
    for (let i = 0; i < 25; i++) await tick();
  }

  beforeAll(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  beforeEach(async () => {
    chrome.local.seed({ [EXCLUDED_SITES_KEY]: ['example.com', 'other.example'] });
    chrome.sessionArea.seed({});
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await startWorker();
  });

  it('removes a site for an extension page', async () => {
    expect(await remove('example.com')).toEqual({ success: true, sites: ['other.example'] });
    expect(stored()).toEqual(['other.example']);
  });

  it('works while the vault is locked', async () => {
    expect(
      await send({ type: 'SETUP_MASTER_PASSWORD', payload: { password: 'correct horse battery' } })
    ).toMatchObject({ success: true });
    await send({ type: 'LOCK_SECURE_STORAGE' });
    expect(await send({ type: 'IS_SECURE_STORAGE_UNLOCKED' })).toMatchObject({
      isUnlocked: false,
      isSetup: true,
    });

    expect(await remove('example.com')).toEqual({ success: true, sites: ['other.example'] });
  });

  it('refuses a request without an RP ID', async () => {
    for (const rpId of [undefined, '', 42]) {
      expect(await remove(rpId)).toMatchObject({ success: false });
    }
    expect(stored()).toEqual(['example.com', 'other.example']);
  });

  it.each([
    ['a web page (or a renderer impersonating its content script)', WEB_PAGE],
    ['the vault dialog in a page', DIALOG_FRAME],
    ['the vault dialog in a window', DIALOG_WINDOW],
  ])('is refused from %s', async (_name, sender) => {
    const response = await remove('example.com', sender);

    expect(response?.success).not.toBe(true);
    expect(stored()).toEqual(['example.com', 'other.example']);
  });

  it('is the store the vault dialog adds to', async () => {
    chrome.local.seed({});
    const opened = await send(
      {
        type: 'PASSKEY_DIALOG_OPEN',
        requestId: 'req-1',
        payload: {
          kind: 'create',
          publicKey: {
            rp: { id: 'example.com', name: 'Example' },
            user: { id: 'AQID', name: 'ada', displayName: 'Ada' },
            challenge: 'AQID',
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          },
        },
      },
      WEB_PAGE
    );
    expect(opened).toMatchObject({ success: true, status: 'open' });
    expect(
      await send({ type: 'PASSKEY_DIALOG_ATTACH', token: opened.token }, DIALOG_FRAME)
    ).toMatchObject({ success: true });

    const decided = await send(
      {
        type: 'PASSKEY_DIALOG_DECIDE',
        token: opened.token,
        decision: { action: 'exclude-site', rpId: 'bank.example' },
      },
      DIALOG_FRAME
    );

    expect(decided).toMatchObject({ success: true });
    // The session's RP ID, whatever else the decision carries.
    expect(stored()).toEqual(['example.com']);
  });
});
