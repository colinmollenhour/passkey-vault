/**
 * Which sites the vault handles WebAuthn requests for.
 *
 * Two settings decide it, kept under separate keys:
 *
 *   domain_rules    the interception mode the user picked in Settings, with
 *                   its allow or block list (suffix match: a rule for
 *                   example.com covers login.example.com)
 *   excluded_sites  RP IDs the user turned the vault off for from its own
 *                   dialog ("Turn off on this site"), matched exactly
 *
 * An excluded RP ID is left to the browser whatever the mode says. Removing
 * it returns the site to the mode. The background is the only writer of
 * excluded_sites (see ExcludedSites in the background), so an exclusion
 * added from a dialog and one removed in Settings cannot overwrite each
 * other.
 */

export const DOMAIN_RULES_KEY = 'domain_rules';
export const EXCLUDED_SITES_KEY = 'excluded_sites';

export type InterceptionMode = 'disabled' | 'all' | 'allowlist' | 'blocklist';

export interface DomainRules {
  mode: InterceptionMode;
  domains: string[];
  /** Let the browser continue when the vault has no passkey (or is locked). */
  passthroughOnNoPasskey: boolean;
}

const MODES: readonly InterceptionMode[] = ['disabled', 'all', 'allowlist', 'blocklist'];

/** Stored (or missing) rules as a complete set, defaulting to every site. */
export function normalizeDomainRules(raw: unknown): DomainRules {
  const partial = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    Record<keyof DomainRules, unknown>
  >;
  return {
    mode: MODES.includes(partial.mode as InterceptionMode)
      ? (partial.mode as InterceptionMode)
      : 'all',
    domains: Array.isArray(partial.domains)
      ? partial.domains.filter((domain): domain is string => typeof domain === 'string')
      : [],
    passthroughOnNoPasskey: partial.passthroughOnNoPasskey !== false,
  };
}

/** An RP ID as it is stored and compared: trimmed, lowercase. */
export function normalizeRpId(rpId: string): string {
  return rpId.trim().toLowerCase();
}

/** Stored (or missing) exclusions: distinct, non-empty, normalized RP IDs. */
export function normalizeExcludedSites(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const sites = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const site = normalizeRpId(entry);
    if (site) sites.add(site);
  }
  return [...sites];
}

/** Whether the user turned the vault off for `rpId`. */
export function isExcludedSite(rpId: string, excluded: string[]): boolean {
  return excluded.includes(normalizeRpId(rpId));
}

/** Whether the vault handles a request for `rpId`. */
export function shouldIntercept(rpId: string, rules: DomainRules, excluded: string[]): boolean {
  return !isExcludedSite(rpId, excluded) && modeIntercepts(rpId, rules);
}

/** Whether the interception mode alone says the vault handles `rpId`. */
export function modeIntercepts(rpId: string, rules: DomainRules): boolean {
  const domain = normalizeRpId(rpId);
  if (rules.mode === 'disabled') return false;
  if (rules.mode === 'all') return true;

  const matches = rules.domains.some((rule) => {
    const normalizedRule = rule.toLowerCase();
    return domain === normalizedRule || domain.endsWith(`.${normalizedRule}`);
  });
  return rules.mode === 'allowlist' ? matches : !matches;
}

/** Both settings, read from extension storage. */
export async function loadInterceptionSettings(): Promise<{
  rules: DomainRules;
  excluded: string[];
}> {
  const stored = await chrome.storage.local.get([DOMAIN_RULES_KEY, EXCLUDED_SITES_KEY]);
  return {
    rules: normalizeDomainRules(stored?.[DOMAIN_RULES_KEY]),
    excluded: normalizeExcludedSites(stored?.[EXCLUDED_SITES_KEY]),
  };
}
