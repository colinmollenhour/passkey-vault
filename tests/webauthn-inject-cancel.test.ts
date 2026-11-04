/**
 * When the page stops waiting for a vault request (the shim's timeout, or
 * the site aborting through options.signal), the shim must tell the content
 * script to cancel. Otherwise its dialog stays up, and a late click creates
 * or signs with a passkey nobody receives. And a request the vault hands
 * to the browser's own prompt reaches that prompt once.
 */

// A module, not a global script: other test files declare the same top-level
// names, and TypeScript would reject the clash when both compile in one worker.
export {};

const nativeGet = navigator.credentials.get as jest.Mock;
const nativeCreate = navigator.credentials.create as jest.Mock;

// Side-effect import: hooks navigator.credentials and listens for messages.
require('../src/content/webauthn-inject');

const PAGE_SOURCE = 'PASSKEY_VAULT_PAGE';

let posted: Array<{ type: string; requestId: string }>;
const record = (event: MessageEvent) => {
  if (event.data?.source === PAGE_SOURCE) posted.push(event.data);
};

beforeEach(() => {
  posted = [];
  nativeGet.mockReset();
  window.addEventListener('message', record);
});

afterEach(() => {
  window.removeEventListener('message', record);
  jest.useRealTimers();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Longer than any timeout the shim allows a ceremony, whatever the RP asks for.
const PAST_ANY_TIMEOUT_MS = 10 * 60 * 1000 + 1;

const createOptions = (signal?: AbortSignal): CredentialCreationOptions => ({
  publicKey: {
    rp: { name: 'Example' },
    user: { id: new Uint8Array([1]), name: 'a', displayName: 'a' },
    challenge: new Uint8Array([9]),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  },
  signal,
});

const getOptions = (signal?: AbortSignal): CredentialRequestOptions => ({
  publicKey: { challenge: new Uint8Array([9]) },
  signal,
});

function cancels() {
  return posted.filter((message) => message.type === 'PASSKEY_CANCEL_REQUEST');
}

describe('webauthn-inject cancellation', () => {
  it('cancels a create in the content script when it times out', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const result = navigator.credentials.create(createOptions());
    const outcome = result.catch((error) => error);

    jest.advanceTimersByTime(PAST_ANY_TIMEOUT_MS);
    jest.useRealTimers();
    await flush();

    const [request] = posted;
    expect(request.type).toBe('PASSKEY_CREATE_REQUEST');
    expect(cancels()).toEqual([expect.objectContaining({ requestId: request.requestId })]);
    expect((await outcome).name).toBe('NotAllowedError');
  });

  it('cancels a get on timeout without opening the native prompt', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const outcome = navigator.credentials.get(getOptions()).catch((error) => error);

    jest.advanceTimersByTime(PAST_ANY_TIMEOUT_MS);
    jest.useRealTimers();
    await flush();

    expect(cancels()).toHaveLength(1);
    expect((await outcome).name).toBe('NotAllowedError');
    expect(nativeGet).not.toHaveBeenCalled();
  });

  it('cancels when the page aborts, rejecting with the abort reason', async () => {
    const controller = new AbortController();
    const outcome = navigator.credentials.get(getOptions(controller.signal)).catch((e) => e);
    await flush();

    controller.abort();
    await flush();

    const [request] = posted;
    expect(cancels()).toEqual([expect.objectContaining({ requestId: request.requestId })]);
    expect((await outcome).name).toBe('AbortError');
    expect(nativeGet).not.toHaveBeenCalled();
  });

  it('does not start a request whose signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await navigator.credentials
      .create(createOptions(controller.signal))
      .catch((error) => error);
    await flush();

    expect(outcome.name).toBe('AbortError');
    expect(posted).toEqual([]);
  });
});

describe('webauthn-inject handing a request to the browser', () => {
  beforeEach(() => nativeCreate.mockReset());

  /** Answer the shim's request as the content script does. */
  function answer(result: Record<string, unknown>): void {
    const [request] = posted;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'PASSKEY_VAULT_CONTENT', requestId: request.requestId, result },
        source: window,
      })
    );
  }

  const passthrough = {
    success: false,
    passthrough: true,
    error: 'User chose other passkey',
    name: 'NotAllowedError',
  };

  it('does not open the browser’s prompt a second time when the user dismisses it', async () => {
    const dismissed = new DOMException('The user dismissed the prompt.', 'NotAllowedError');
    nativeGet.mockRejectedValue(dismissed);
    const outcome = navigator.credentials.get(getOptions()).catch((error) => error);
    await flush();

    answer(passthrough);

    expect(await outcome).toBe(dismissed);
    expect(nativeGet).toHaveBeenCalledTimes(1);
  });

  it('still tries the browser once when the vault fails without blocking it', async () => {
    nativeGet.mockResolvedValue({ id: 'native' });
    const outcome = navigator.credentials.get(getOptions());
    await flush();

    answer({ success: false, error: 'No passkey', name: 'NotAllowedError' });

    expect(await outcome).toEqual({ id: 'native' });
    expect(nativeGet).toHaveBeenCalledTimes(1);
  });

  it('gives a create to the browser with the page’s own options, once', async () => {
    const dismissed = new DOMException('The user dismissed the prompt.', 'NotAllowedError');
    nativeCreate.mockRejectedValue(dismissed);
    const controller = new AbortController();
    const options = createOptions(controller.signal);
    const outcome = navigator.credentials.create(options).catch((error) => error);
    await flush();

    answer({ ...passthrough, error: 'User chose another device' });

    expect(await outcome).toBe(dismissed);
    expect(nativeCreate).toHaveBeenCalledTimes(1);
    expect(nativeCreate.mock.calls[0][0]).toBe(options);
  });
});
