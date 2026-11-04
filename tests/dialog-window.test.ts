/**
 * @jest-environment ./tests/helpers/vault-environment.js
 *
 * Where the browser cannot report whether a frame on the page is really
 * visible (no IntersectionObserver v2: Firefox), the vault's dialog opens
 * in a popup window of its own, which a page cannot fade, cover or
 * shrink. Ceremonies through the whole extension, with the dialog in a
 * window.
 */

import { setupVault, vaultReady } from './helpers/harness';
import { authenticate, outcome, register } from './helpers/ceremony';
import {
  authenticationJSON,
  creationOptionsFromJSON,
  registrationJSON,
  requestOptionsFromJSON,
} from './helpers/options';

const vault = setupVault('https://example.com/login');

beforeAll(() => vaultReady(vault));
beforeEach(async () => {
  await vault.reset();
  vault.goto('https://example.com/login');
  vault.dialogMode = 'window';
});

const signIn = (extra: Record<string, unknown> = {}) =>
  outcome(
    navigator.credentials.get({
      publicKey: requestOptionsFromJSON(authenticationJSON({ rpId: 'example.com' })),
      ...extra,
    })
  );

describe('a dialog in a window', () => {
  it('registers and signs in, mounting nothing in the page', async () => {
    const registration = await register();
    await authenticate(registration);
    await vault.settle();

    expect(vault.dialogs.map((dialog) => [dialog.mode, dialog.kind])).toEqual([
      ['window', 'create'],
      ['window', 'get'],
    ]);
    expect(vault.chrome.windows.every((window) => !window.open)).toBe(true);
    expect(document.documentElement.children).toHaveLength(2);
  });

  it('refuses the sign-in when the user closes the window', async () => {
    await register();
    vault.user.choosePasskey.mockImplementation(() => {
      const [window] = vault.chrome.windows.filter((candidate) => candidate.open);
      vault.chrome.closeWindow(window.id);
      return new Promise(() => undefined);
    });

    const { error } = await signIn();

    expect(error?.name).toBe('NotAllowedError');
    expect(vault.native.get).not.toHaveBeenCalled();
  });

  it('closes the window when the page aborts', async () => {
    await register();
    const controller = new AbortController();
    vault.user.choosePasskey.mockImplementation(() => {
      controller.abort();
      return new Promise(() => undefined);
    });

    const { error } = await signIn({ signal: controller.signal });
    await vault.settle();

    expect(error?.name).toBe('AbortError');
    expect(vault.chrome.windows.every((window) => !window.open)).toBe(true);
  });

  it('opens the window unplaced when the browser refuses its position', async () => {
    const registration = await register();
    // Chrome refuses bounds less than half on a visible screen, as when the
    // requesting window sits mostly off-screen.
    vault.chrome.refuseWindowPlacement = true;

    await authenticate(registration);

    expect(vault.dialogs.map((dialog) => [dialog.mode, dialog.kind])).toEqual([
      ['window', 'create'],
      ['window', 'get'],
    ]);
  });
});

describe('an autofill sign-in with the dialog in a window', () => {
  it('waits for the user to ask before opening the window', async () => {
    const registration = await register();
    vault.user.launch.mockReturnValue(new Promise(() => undefined));

    void signIn({ mediation: 'conditional' });
    await vault.settle();

    expect(vault.launchers).toEqual(['example.com']);
    expect(vault.dialogs.filter((dialog) => dialog.kind === 'get')).toEqual([]);
    expect(vault.chrome.windows.filter((window) => window.open)).toEqual([]);
    void registration;
  });

  it('signs in through the window once the user asks for it', async () => {
    const registration = await register();

    const { value, error } = await signIn({ mediation: 'conditional' });

    expect(error).toBeUndefined();
    expect((value as any).id).toBe(registration.record.id);
    expect(vault.dialogs.map((dialog) => dialog.mode)).toEqual(['window', 'window']);
  });

  it.each([['cancel'], ['passthrough']])(
    'leaves the request to the browser’s own autofill on %s',
    async (choice) => {
      await register();
      vault.user.launch.mockReturnValue(choice);
      vault.native.get.mockResolvedValue({ id: 'browser-autofill' });

      const { value } = await signIn({ mediation: 'conditional' });

      expect((value as any)?.id).toBe('browser-autofill');
      expect(vault.dialogs.filter((dialog) => dialog.kind === 'get')).toEqual([]);
    }
  );
});

describe('registration with the dialog in a window', () => {
  it('creates nothing when the user closes the window', async () => {
    vault.user.confirmCreate.mockImplementation(() => {
      const [window] = vault.chrome.windows.filter((candidate) => candidate.open);
      vault.chrome.closeWindow(window.id);
      return new Promise(() => undefined);
    });

    const { error } = await outcome(
      navigator.credentials.create({
        publicKey: creationOptionsFromJSON(
          registrationJSON({ rp: { name: 'Example', id: 'example.com' } })
        ),
      })
    );

    expect(error?.name).toBe('NotAllowedError');
    expect(await vault.passkeys()).toEqual([]);
  });

  const create = () =>
    outcome(
      navigator.credentials.create({
        publicKey: creationOptionsFromJSON(
          registrationJSON({ rp: { name: 'Example', id: 'example.com' } })
        ),
      })
    );

  /**
   * The browser's own prompt, which works only for a page with focus: the
   * window must be gone, and the page focused, by the time it is called.
   */
  function browserPrompt(id: string) {
    const seen: Array<{ windowsOpen: boolean; focused: boolean }> = [];
    vault.native.create.mockImplementation(async () => {
      seen.push({
        windowsOpen: vault.chrome.windows.some((candidate) => candidate.open),
        focused: document.hasFocus(),
      });
      return { id };
    });
    return seen;
  }

  it('hands the request to the browser on "Use another device", once the window is gone', async () => {
    vault.user.confirmCreate.mockReturnValue('passthrough');
    const seen = browserPrompt('security-key');

    const { value } = await create();

    expect((value as any)?.id).toBe('security-key');
    expect(seen).toEqual([{ windowsOpen: false, focused: true }]);
    expect(await vault.passkeys()).toEqual([]);
  });

  it('turns the vault off for the site and hands the request to the browser', async () => {
    vault.user.confirmCreate.mockReturnValue('exclude-site');
    const seen = browserPrompt('browser');

    const { value } = await create();
    const again = await create();

    expect((value as any)?.id).toBe('browser');
    expect((again.value as any)?.id).toBe('browser');
    expect(seen[0]).toEqual({ windowsOpen: false, focused: true });
    expect(vault.native.create).toHaveBeenCalledTimes(2);
    expect(vault.storage.excluded_sites).toEqual(['example.com']);
    expect(vault.dialogs).toHaveLength(1);
  });
});

describe('a sign-in in a window, left to the browser', () => {
  it('turns the vault off for the site from the picker', async () => {
    await register();
    vault.user.choosePasskey.mockReturnValue({ action: 'exclude-site' });
    vault.native.get.mockResolvedValue({ id: 'browser' });

    const { value } = await signIn();

    expect((value as any)?.id).toBe('browser');
    expect(vault.native.get).toHaveBeenCalledTimes(1);
    expect(vault.storage.excluded_sites).toEqual(['example.com']);
    expect(vault.chrome.windows.every((window) => !window.open)).toBe(true);
  });
});
