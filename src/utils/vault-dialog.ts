/**
 * The vault's ceremony dialogs: the passkey picker and the create
 * confirmation.
 *
 * They are an extension page (vault-dialog.html), never page DOM. In
 * Chrome the content script shows that page in an iframe inside a closed
 * shadow root, so the page can neither read the dialog (it is another
 * origin, and the frame is not in `window.frames`) nor script it. Where
 * the dialog cannot tell whether it is really visible in the page (no
 * IntersectionObserver v2, as in Firefox), it opens in a popup window of
 * its own instead, which a page cannot draw over.
 *
 * The dialog gets what it shows from the background, and its decision goes
 * to the background, never through the page or the content script:
 *
 *   content script ── PASSKEY_DIALOG_OPEN ──────────────▶ background
 *        ◀──────────── { dialogId, token } ──────────────  (session)
 *        │ token by postMessage to the frame (targetOrigin: the extension)
 *   dialog page ───── PASSKEY_DIALOG_ATTACH { token } ──▶ background
 *        ◀──────────── what to show ─────────────────────
 *   dialog page ───── PASSKEY_DIALOG_DECIDE { token } ──▶ background
 *   content script ◀─ PASSKEY_DIALOG_RESULT ───────────── background
 *   content script ── GET_PASSKEY / CREATE_PASSKEY ─────▶ background
 *                     (refused unless the dialog approved this request)
 *
 * In a window, the background opens the dialog page with the token in its
 * URL; the page that asked has no handle on that window.
 *
 * Besides answering, the user can hand a request back to the browser. The
 * code uses two words for that, and never "disabled", which is the
 * interception mode that turns the vault off everywhere:
 *
 *   passthrough   this one request goes to the browser's own WebAuthn UI
 *                 ("Use another device" when creating, "Use other passkey"
 *                 when signing in), for a security key or a phone
 *   exclude       the vault stays out of this RP ID from now on ("Turn off
 *                 on {rp}"); the background records it in excluded_sites
 *                 (see src/utils/domain-rules.ts), and this request also
 *                 goes to the browser
 */

export const VAULT_DIALOG_PAGE = 'vault-dialog.html';

export type VaultDialogKind = 'get' | 'create';

/** An iframe in the page, or a popup window of its own. */
export type VaultDialogMode = 'frame' | 'window';

/**
 * What the content script learns: whether to go on with the ceremony. It
 * never learns which passkey the user picked; the background keeps that.
 * "escalated": the framed dialog moved to a window; take the frame down
 * and keep waiting. "excluded": the site is now excluded, so hand the
 * request to the browser.
 */
export type VaultDialogOutcome = 'approved' | 'cancel' | 'passthrough' | 'excluded' | 'escalated';

export interface VaultDialogPasskey {
  id: string;
  userName: string;
  userDisplayName: string;
}

export type VaultDialogView =
  | { kind: 'get'; mode: VaultDialogMode; rpId: string; passkeys: VaultDialogPasskey[] }
  | { kind: 'create'; mode: VaultDialogMode; rpId: string; userName: string };

/**
 * "exclude-site" names no site: the background excludes the RP ID of the
 * session it bound to the requesting frame, whatever a message says.
 */
export type VaultDialogDecision =
  | { action: 'use'; id: string }
  | { action: 'create' }
  | { action: 'cancel' }
  | { action: 'passthrough' }
  | { action: 'exclude-site' };

/** The DECIDE answer when the exclusion could not be saved; the dialog stays open. */
export const EXCLUDE_FAILED = 'EXCLUDE_FAILED';

export const DIALOG_MESSAGES = {
  /** Content script: open a dialog for one of its requests. */
  OPEN: 'PASSKEY_DIALOG_OPEN',
  /** Content script: the user asked for a deferred (autofill) dialog's window. */
  LAUNCH: 'PASSKEY_DIALOG_LAUNCH',
  /** Content script: the page gave up on the request. */
  CANCEL: 'PASSKEY_DIALOG_CANCEL',
  /** Dialog page: claim a session with its token and fetch what to show. */
  ATTACH: 'PASSKEY_DIALOG_ATTACH',
  /** Dialog page: the top-level page's device pixel ratio, to detect CSS zoom. */
  METRICS: 'PASSKEY_DIALOG_METRICS',
  /** Dialog page: the user's decision. */
  DECIDE: 'PASSKEY_DIALOG_DECIDE',
  /** Dialog page: move a frame that cannot show it is visible to a window. */
  ESCALATE: 'PASSKEY_DIALOG_ESCALATE',
  /** Background to content script: the outcome of a dialog. */
  RESULT: 'PASSKEY_DIALOG_RESULT',
  /** Background to the top frame's content script: its device pixel ratio. */
  TOP_METRICS: 'PASSKEY_VAULT_TOP_METRICS',
  /** Background to the top frame's content script: a site was turned off. */
  SITE_EXCLUDED: 'PASSKEY_VAULT_SITE_EXCLUDED',
} as const;

/** The postMessage that hands a framed dialog its token. */
export const DIALOG_TOKEN_MESSAGE = 'fenko-vault-dialog-token';

/**
 * Fixed frame sizes. The picker's does not depend on how many passkeys it
 * lists: the page can measure the frame's host, and must not learn the
 * number of accounts from it. The heights are the measured layout: the
 * header with a two-line message, the status row, the body (two passkeys
 * and part of a third, or the new passkey's account), and the footer with
 * its first row on two lines, as the longer translations need, and the
 * "Turn off" row.
 */
export const DIALOG_FRAME_SIZE: Record<VaultDialogKind, { width: number; height: number }> = {
  get: { width: 340, height: 398 },
  create: { width: 340, height: 320 },
};

/** How long the dialog must have been fully visible before a click counts. */
export const CONSENT_DWELL_MS = 500;

/**
 * Outer size of the popup window: the frame, plus room for the title bar.
 * A window has no status row, so the same footer leaves its body a little
 * more room than the frame's.
 */
export const DIALOG_WINDOW_SIZE: Record<VaultDialogKind, { width: number; height: number }> = {
  get: { width: 380, height: 466 },
  create: { width: 380, height: 388 },
};

/**
 * Whether a message sender is the vault's dialog page. Only the browser sets
 * `sender.id`, and only this extension's pages have an extension URL with
 * it, so a web page cannot pass for the dialog.
 */
export function isVaultDialogSender(
  sender: { id?: string; url?: string } | undefined,
  extensionId: string
): boolean {
  if (!sender || sender.id !== extensionId || typeof sender.url !== 'string') return false;
  try {
    const url = new URL(sender.url);
    return (
      (url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:') &&
      url.pathname === `/${VAULT_DIALOG_PAGE}`
    );
  } catch {
    return false;
  }
}
