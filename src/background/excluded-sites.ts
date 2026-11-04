/**
 * The one writer of chrome.storage.local['excluded_sites'], the RP IDs the
 * user turned the vault off for (see src/utils/domain-rules.ts).
 *
 * Two places change the list: the vault's dialog adds the site of the
 * request it shows (through the DialogBroker's excludeSite dependency), and
 * Settings removes sites (EXCLUDED_SITES_REMOVE, extension pages only). Each
 * change reads, modifies and writes the list in one queue, so an addition
 * and a removal that overlap cannot overwrite each other. The list is a
 * setting, not vault data: it is readable and changeable while the vault is
 * locked.
 */

import { EXCLUDED_SITES_KEY, normalizeExcludedSites, normalizeRpId } from '../utils/domain-rules';

export class ExcludedSites {
  private queue: Promise<unknown> = Promise.resolve();

  /** The stored list. */
  async list(): Promise<string[]> {
    const stored = await chrome.storage.local.get(EXCLUDED_SITES_KEY);
    return normalizeExcludedSites(stored?.[EXCLUDED_SITES_KEY]);
  }

  /** Exclude `rpId`; already excluded is fine. Rejects if the write failed. */
  async add(rpId: string): Promise<string[]> {
    const site = ExcludedSites.site(rpId);
    return this.update((sites) => (sites.includes(site) ? sites : [...sites, site]));
  }

  /** Return `rpId` to the interception mode; not excluded is fine. */
  async remove(rpId: string): Promise<string[]> {
    const site = ExcludedSites.site(rpId);
    return this.update((sites) => sites.filter((entry) => entry !== site));
  }

  private static site(rpId: string): string {
    const site = typeof rpId === 'string' ? normalizeRpId(rpId) : '';
    if (!site) throw new Error('An RP ID is required');
    return site;
  }

  private update(change: (sites: string[]) => string[]): Promise<string[]> {
    const result = this.queue.then(async () => {
      const stored = await chrome.storage.local.get(EXCLUDED_SITES_KEY);
      const raw = stored?.[EXCLUDED_SITES_KEY];
      const sites = change(normalizeExcludedSites(raw));
      // Rewritten when it changes, or when what is stored is not in normal form.
      if (JSON.stringify(sites) !== JSON.stringify(raw ?? [])) {
        await chrome.storage.local.set({ [EXCLUDED_SITES_KEY]: sites });
      }
      return sites;
    });
    // A failed write fails its caller, not the changes queued after it.
    this.queue = result.catch(() => {});
    return result;
  }
}
