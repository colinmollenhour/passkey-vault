/**
 * The vault's ceremony dialog: the passkey picker and the create
 * confirmation (see src/utils/vault-dialog.ts for how it is wired).
 *
 * This is an extension page. The page that asked for a passkey can neither
 * read it nor script it; what it shows comes from the background, and the
 * user's decision goes back there.
 */

import { initI18n, t } from '../i18n';
import { initTheme } from '../theme';
import {
  DIALOG_MESSAGES,
  DIALOG_TOKEN_MESSAGE,
  EXCLUDE_FAILED,
  type VaultDialogDecision,
  type VaultDialogMode,
  type VaultDialogView,
} from '../utils/vault-dialog';
import type { ConsentGate } from './consent-gate';

export type { ConsentGate } from './consent-gate';

export interface GateContext {
  mode: VaultDialogMode;
  /** The top-level page's devicePixelRatio, from the background. */
  reference(): Promise<number | undefined>;
  /**
   * Whether the parts the user decides on are all inside the viewport:
   * the title and message, the passkey selected (or the new passkey's
   * account), and the buttons. A frame
   * the page made too small to show them crops the dialog's content while
   * the dialog itself still "fits".
   */
  fits(): boolean;
}

/**
 * How long a framed dialog may fail to show it is visible before it offers
 * to move to a window.
 */
export const UNVERIFIED_MS = 1500;

export interface DialogEnvironment {
  window: Window;
  /** In a popup window of its own, rather than a frame on the page. */
  inWindow: boolean;
  /** The token that names this dialog's session. */
  token(): Promise<string>;
  send(message: Record<string, unknown>): Promise<unknown>;
  /** The gate for consent clicks, once the dialog is on screen. */
  createGate(card: HTMLElement, context: GateContext): ConsentGate;
}

const LOCK_ICON =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>';

/**
 * The token of a dialog the background opened in a window: in the URL's
 * fragment, which is then dropped from the address.
 */
export function takeTokenFromUrl(win: Window): string {
  const token = win.location.hash.slice(1);
  win.history.replaceState(null, '', win.location.pathname);
  return token;
}

/**
 * Resolve with the first token the frame's parent posts. Only the content
 * script can reach this frame: it sits in a closed shadow root, so it is
 * not in the page's `window.frames`, and the page has no handle to post to.
 */
export function receiveTokenFromParent(win: Window): Promise<string> {
  return new Promise((resolve) => {
    const listener = (event: MessageEvent) => {
      if (event.source !== win.parent || win.parent === win) return;
      const data = event.data as { type?: unknown; token?: unknown } | null;
      if (data?.type !== DIALOG_TOKEN_MESSAGE || typeof data.token !== 'string') return;
      win.removeEventListener('message', listener);
      resolve(data.token);
    };
    win.addEventListener('message', listener);
  });
}

export class VaultDialog {
  private readonly doc: Document;
  private token = '';
  private gate: ConsentGate | null = null;
  private settled = false;
  private selectedId: string | null = null;
  /** The RP ID the dialog is for, as the background bound it. */
  private rpId = '';
  private readonly consentButtons: HTMLButtonElement[] = [];
  private mode: VaultDialogMode = 'frame';
  private unverifiedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly env: DialogEnvironment) {
    this.doc = env.window.document;
  }

  private el<T extends HTMLElement = HTMLElement>(id: string): T {
    return this.doc.getElementById(id) as T;
  }

  async start(): Promise<void> {
    this.token = await this.env.token();
    let response: { success?: boolean; view?: VaultDialogView } | undefined;
    try {
      response = (await this.env.send({ type: DIALOG_MESSAGES.ATTACH, token: this.token })) as
        | { success?: boolean; view?: VaultDialogView }
        | undefined;
    } catch {
      response = undefined;
    }
    if (!response?.success || !response.view) {
      this.showInactive();
      return;
    }
    this.render(response.view);
  }

  private render(view: VaultDialogView): void {
    const card = this.el('card');
    const footer = this.el('footer');
    const list = this.el('passkeys');
    footer.textContent = '';
    list.textContent = '';
    this.rpId = view.rpId;

    if (view.kind === 'get') {
      this.el('title').textContent = t('pageChoosePasskey');
      this.el('subtitle').textContent = t('pageSignInTo', { rp: view.rpId });
      list.setAttribute('aria-label', t('pageChoosePasskey'));
      view.passkeys.forEach((passkey, index) => {
        list.appendChild(this.passkeyItem(passkey, index === 0));
      });
      this.selectedId = view.passkeys[0]?.id ?? null;
      footer.append(
        this.button('pkv-cancel', t('commonCancel'), 'secondary', () =>
          this.decide({ action: 'cancel' })
        ),
        this.button('pkv-passthrough', t('pageUseOtherPasskey'), 'secondary', () =>
          this.decide({ action: 'passthrough' })
        ),
        this.button(
          'pkv-continue',
          t('pageContinue'),
          'primary wide',
          () => {
            if (this.selectedId) this.decide({ action: 'use', id: this.selectedId });
          },
          true
        ),
        this.excludeButton(view.rpId)
      );
    } else {
      // The account the passkey is for, where the picker lists passkeys:
      // what a native prompt shows, and it fills the frame's fixed body.
      list.removeAttribute('role');
      list.appendChild(this.newPasskeySummary(view.userName, view.rpId));
      this.el('body').classList.add('centered');
      this.el('title').textContent = t('pageCreatePasskeyTitle');
      this.el('subtitle').textContent = t('pageCreatePasskeyMsg', {
        user: view.userName || t('commonUnknownUser'),
        rp: view.rpId,
      });
      // The same layout as the picker's: the two ways out side by side,
      // the confirmation below them. "Use another device" hands this one
      // request to the browser's own dialog (a security key, a phone),
      // which asks for its own consent, so it needs none here.
      footer.append(
        this.button('pkv-cancel', t('commonCancel'), 'secondary', () =>
          this.decide({ action: 'cancel' })
        ),
        this.button('pkv-passthrough', t('pageUseAnotherDevice'), 'secondary', () =>
          this.decide({ action: 'passthrough' })
        ),
        this.button(
          'pkv-create',
          t('pageCreate'),
          'primary wide',
          () => this.decide({ action: 'create' }),
          true
        ),
        this.excludeButton(view.rpId)
      );
    }

    this.doc.addEventListener('keydown', (event) => {
      if (event.isTrusted && event.key === 'Escape') this.decide({ action: 'cancel' });
    });

    card.hidden = false;
    this.mode = view.mode;
    this.doc.documentElement.classList.toggle('in-window', view.mode === 'window');
    this.armGate();
    this.focusStart();
  }

  /**
   * Open a new consent gate: consent buttons count only once it says the
   * dialog has been on screen long enough, from now.
   */
  private armGate(): void {
    this.gate?.dispose();
    const gate = this.env.createGate(this.el('card'), {
      mode: this.mode,
      reference: () => this.reference(),
      fits: () => this.fits(),
    });
    this.gate = gate;
    gate.onChange(() => {
      if (this.gate === gate) this.updateConsentButtons();
    });
    this.updateConsentButtons();
  }

  /**
   * Focus the selection, or the dialog itself: never a consent button, so
   * a keystroke meant for the page cannot confirm.
   */
  private focusStart(): void {
    const checked = this.el('passkeys').querySelector<HTMLElement>('[aria-checked="true"]');
    (checked ?? this.el('card')).focus({ preventScroll: true });
  }

  /**
   * "Turn off on {rp}": a persistent change to the user's settings, so it
   * is a consent button like Create and Continue, and it sits in the
   * footer, which the gate checks is in view. The decision names no site;
   * the background excludes the RP ID of this dialog's session.
   */
  private excludeButton(rpId: string): HTMLButtonElement {
    const button = this.button(
      'pkv-exclude',
      t('dialogExcludeSite', { rp: rpId }),
      'link wide',
      () => this.decide({ action: 'exclude-site' }),
      true
    );
    // The label can be cut short for a long RP ID; the tooltip has all of
    // it, and what turning it off means.
    button.title = `${t('dialogExcludeSite', { rp: rpId })}\n${t('dialogExcludeSiteHint', { rp: rpId })}`;
    return button;
  }

  /** A read-only row like a picker entry: the new passkey's account and site. */
  private newPasskeySummary(userName: string, rpId: string): HTMLElement {
    const row = this.doc.createElement('div');
    row.className = 'passkey-item passkey-summary';
    const avatar = this.doc.createElement('span');
    avatar.className = 'passkey-avatar';
    avatar.innerHTML = LOCK_ICON;
    const info = this.doc.createElement('span');
    info.className = 'passkey-info';
    const name = this.doc.createElement('span');
    name.className = 'passkey-name';
    name.textContent = userName || t('commonUnknownUser');
    const detail = this.doc.createElement('span');
    detail.className = 'passkey-detail';
    detail.textContent = rpId;
    info.append(name, detail);
    row.append(avatar, info);
    return row;
  }

  private passkeyItem(
    passkey: { id: string; userName: string; userDisplayName: string },
    selected: boolean
  ): HTMLElement {
    const item = this.doc.createElement('button');
    item.type = 'button';
    item.className = 'passkey-item';
    item.setAttribute('role', 'radio');
    item.setAttribute('aria-checked', String(selected));
    item.tabIndex = selected ? 0 : -1;
    item.dataset.id = passkey.id;

    const avatar = this.doc.createElement('span');
    avatar.className = 'passkey-avatar';
    avatar.innerHTML = LOCK_ICON;
    const info = this.doc.createElement('span');
    info.className = 'passkey-info';
    const name = this.doc.createElement('span');
    name.className = 'passkey-name';
    name.textContent = passkey.userDisplayName || passkey.userName || t('commonUnknownUser');
    const detail = this.doc.createElement('span');
    detail.className = 'passkey-detail';
    detail.textContent = passkey.userName || passkey.id.substring(0, 16) + '...';
    info.append(name, detail);
    const check = this.doc.createElement('span');
    check.className = 'passkey-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = '✓';
    item.append(avatar, info, check);

    item.addEventListener('click', (event) => {
      if (event.isTrusted) this.select(item);
    });
    item.addEventListener('keydown', (event) => {
      if (!event.isTrusted) return;
      const items = Array.from(
        this.el('passkeys').querySelectorAll<HTMLButtonElement>('.passkey-item')
      );
      const index = items.indexOf(item);
      let next = -1;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = index + 1;
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = index - 1;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = items.length - 1;
      if (next < 0 && event.key !== 'Home') return;
      event.preventDefault();
      const target = items[(next + items.length) % items.length];
      this.select(target);
      target.focus();
    });
    return item;
  }

  private select(item: HTMLElement): void {
    this.el('passkeys')
      .querySelectorAll<HTMLElement>('.passkey-item')
      .forEach((other) => {
        other.setAttribute('aria-checked', String(other === item));
        other.tabIndex = other === item ? 0 : -1;
      });
    this.selectedId = item.dataset.id ?? null;
    this.gate?.refresh();
  }

  private button(
    id: string,
    label: string,
    variant: string,
    action: () => void,
    consent = false
  ): HTMLButtonElement {
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.id = id;
    button.className = variant
      .split(' ')
      .map((part) => (part === 'wide' ? 'wide' : `btn-${part}`))
      .concat('btn')
      .join(' ');
    button.textContent = label;
    button.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      // A consent click counts only once the gate says the dialog has been
      // on screen, in full, long enough for the user to have seen it.
      if (consent && !this.gate?.isReady()) return;
      action();
    });
    if (consent) this.consentButtons.push(button);
    return button;
  }

  private updateConsentButtons(): void {
    const ready = !!this.gate?.isReady() && !this.settled;
    for (const button of this.consentButtons) {
      button.setAttribute('aria-disabled', String(!ready));
    }
    // A frame that cannot show it is visible for a while (the page covers
    // or shrinks it, or the browser cannot tell) offers a window instead,
    // which the page cannot draw over. The offer is no consent: the user
    // still decides in the window.
    if (ready || this.settled || this.mode !== 'frame') {
      if (this.unverifiedTimer) clearTimeout(this.unverifiedTimer);
      this.unverifiedTimer = null;
      if (ready) this.el('status').hidden = true;
    } else if (!this.unverifiedTimer && this.el('status').hidden) {
      this.unverifiedTimer = setTimeout(() => {
        this.unverifiedTimer = null;
        if (!this.gate?.isReady() && !this.settled) this.showUnverified();
      }, UNVERIFIED_MS);
    }
  }

  private showUnverified(): void {
    const status = this.el('status');
    const text = this.doc.createElement('span');
    text.className = 'status-text';
    text.textContent = t('dialogNotVisible');
    status.replaceChildren(text);
    const move = this.doc.createElement('button');
    move.type = 'button';
    move.id = 'pkv-open-window';
    move.className = 'link-btn';
    move.textContent = t('dialogOpenWindow');
    move.addEventListener('click', (event) => {
      if (event.isTrusted) void this.escalate();
    });
    status.append(move);
    status.hidden = false;
  }

  /** Move this dialog to a window; the content script takes the frame down. */
  private async escalate(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.updateConsentButtons();
    this.gate?.dispose();
    let response: { success?: boolean } | undefined;
    try {
      response = (await this.env.send({
        type: DIALOG_MESSAGES.ESCALATE,
        token: this.token,
      })) as { success?: boolean } | undefined;
    } catch {
      response = undefined;
    }
    if (!response?.success) this.showInactive();
  }

  private fits(): boolean {
    const win = this.env.window;
    const inView = (element: Element | null) => {
      if (!element) return true;
      const rect = element.getBoundingClientRect();
      return (
        rect.top >= -0.5 &&
        rect.left >= -0.5 &&
        rect.bottom <= win.innerHeight + 0.5 &&
        rect.right <= win.innerWidth + 0.5
      );
    };
    const whole = (element: HTMLElement) =>
      inView(element) &&
      element.scrollHeight <= element.clientHeight + 1 &&
      element.scrollWidth <= element.clientWidth + 1;
    const body = this.el('body').getBoundingClientRect();
    // The row the decision is about: the passkey picked, or the account
    // a new passkey is for. Either must be in the body, not cut by it.
    const passkeys = this.el('passkeys');
    const selected =
      passkeys.querySelector('[aria-checked="true"]') ?? passkeys.querySelector('.passkey-summary');
    const selectedShown =
      !selected ||
      (() => {
        const rect = selected.getBoundingClientRect();
        return inView(selected) && rect.top >= body.top - 0.5 && rect.bottom <= body.bottom + 0.5;
      })();
    return (
      whole(this.el('title')) &&
      whole(this.el('subtitle')) &&
      inView(this.el('footer')) &&
      selectedShown
    );
  }

  private async reference(): Promise<number | undefined> {
    try {
      const response = (await this.env.send({
        type: DIALOG_MESSAGES.METRICS,
        token: this.token,
      })) as { success?: boolean; dpr?: unknown } | undefined;
      return response?.success && typeof response.dpr === 'number' ? response.dpr : undefined;
    } catch {
      return undefined;
    }
  }

  private async decide(decision: VaultDialogDecision): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.updateConsentButtons();
    this.gate?.dispose();
    let response: { success?: boolean; code?: unknown } | undefined;
    let unanswered = false;
    try {
      response = (await this.env.send({
        type: DIALOG_MESSAGES.DECIDE,
        token: this.token,
        decision,
      })) as { success?: boolean; code?: unknown } | undefined;
    } catch {
      response = undefined;
      unanswered = true;
    }
    if (!response?.success) {
      // No answer at all means the worker stopped while saving, which
      // leaves the session pending: decidable again, not gone. A retry
      // that finds it gone gets "no longer active" then.
      if (decision.action === 'exclude-site' && (unanswered || response?.code === EXCLUDE_FAILED)) {
        this.showExcludeFailed();
        return;
      }
      this.showInactive();
      return;
    }
    // The background closes the window too; this is in case it cannot.
    if (this.env.inWindow) this.env.window.close();
  }

  /**
   * The exclusion did not finish, and the request is still open: say so
   * and let the user decide again. The status row is the window offer's,
   * so the error takes the message's place: the header keeps its height.
   * The message named the site, and on the sign-in picker nothing else
   * names it in full, so the error names it too: consent starts over on a
   * dialog that still says which site it is for. The gate waits again
   * before any consent click counts. The error says turning off failed,
   * not that nothing was saved: the site may be saved while ending the
   * request failed, and a retry saves it again harmlessly. It must fit the
   * message's two lines, a long RP ID included, or the gate cannot open.
   */
  private showExcludeFailed(): void {
    const error = this.doc.createElement('span');
    error.className = 'card-error';
    error.setAttribute('role', 'alert');
    error.textContent = t('dialogExcludeFailed', { rp: this.rpId });
    this.el('subtitle').replaceChildren(error);
    this.settled = false;
    this.armGate();
    this.focusStart();
  }

  /** The request is gone: the page gave up, or another dialog replaced this one. */
  private showInactive(): void {
    this.settled = true;
    this.gate?.dispose();
    this.el('title').textContent = t('appName');
    this.el('subtitle').textContent = t('dialogInactive');
    this.el('passkeys').textContent = '';
    this.el('footer').textContent = '';
    this.el('status').hidden = true;
    if (this.env.inWindow) {
      this.el('footer').append(
        this.button('pkv-close', t('commonClose'), 'secondary wide', () => this.env.window.close())
      );
    }
    this.el('card').hidden = false;
  }
}

export async function startVaultDialog(env: DialogEnvironment): Promise<VaultDialog> {
  await Promise.all([initI18n(), initTheme()]);
  const dialog = new VaultDialog(env);
  await dialog.start();
  return dialog;
}
