/**
 * Which sites the vault handles: the interception mode from Settings, and
 * the sites the user turned the vault off for from its dialog.
 */

import {
  DOMAIN_RULES_KEY,
  EXCLUDED_SITES_KEY,
  loadInterceptionSettings,
  normalizeDomainRules,
  normalizeExcludedSites,
  normalizeRpId,
  shouldIntercept,
  type DomainRules,
  type InterceptionMode,
} from '../src/utils/domain-rules';

const rules = (mode: InterceptionMode, domains: string[] = []): DomainRules => ({
  mode,
  domains,
  passthroughOnNoPasskey: true,
});

const MODES: InterceptionMode[] = ['disabled', 'all', 'allowlist', 'blocklist'];

describe('normalizeDomainRules', () => {
  it('defaults missing rules to every site', () => {
    for (const raw of [undefined, null, 'all', 42, []]) {
      expect(normalizeDomainRules(raw)).toEqual({
        mode: 'all',
        domains: [],
        passthroughOnNoPasskey: true,
      });
    }
  });

  it('keeps rules stored by earlier versions', () => {
    expect(
      normalizeDomainRules({
        mode: 'blocklist',
        domains: ['example.com', 'github.com'],
        passthroughOnNoPasskey: false,
      })
    ).toEqual({
      mode: 'blocklist',
      domains: ['example.com', 'github.com'],
      passthroughOnNoPasskey: false,
    });
    // Before the native fallback toggle existed, it was on.
    expect(normalizeDomainRules({ mode: 'allowlist', domains: ['a.example'] })).toEqual({
      mode: 'allowlist',
      domains: ['a.example'],
      passthroughOnNoPasskey: true,
    });
  });

  it('only turns the native fallback off for an explicit false', () => {
    expect(normalizeDomainRules({ passthroughOnNoPasskey: 0 }).passthroughOnNoPasskey).toBe(true);
    expect(normalizeDomainRules({ passthroughOnNoPasskey: 'no' }).passthroughOnNoPasskey).toBe(
      true
    );
    expect(normalizeDomainRules({ passthroughOnNoPasskey: false }).passthroughOnNoPasskey).toBe(
      false
    );
  });

  it('replaces an unknown mode with every site and drops domains that are not strings', () => {
    expect(normalizeDomainRules({ mode: 'everything', domains: ['a.example', 7, null] })).toEqual({
      mode: 'all',
      domains: ['a.example'],
      passthroughOnNoPasskey: true,
    });
    expect(normalizeDomainRules({ mode: 'allowlist', domains: 'a.example' }).domains).toEqual([]);
  });
});

describe('normalizeExcludedSites', () => {
  it('reads a missing or malformed list as empty', () => {
    for (const raw of [undefined, null, 'example.com', { 0: 'example.com' }, 3]) {
      expect(normalizeExcludedSites(raw)).toEqual([]);
    }
  });

  it('trims, lowercases, drops empty and non-string entries, and removes duplicates', () => {
    expect(
      normalizeExcludedSites([
        ' Example.COM ',
        'example.com',
        '',
        '   ',
        5,
        null,
        'login.example.com',
      ])
    ).toEqual(['example.com', 'login.example.com']);
  });

  it('normalizes an RP ID the same way', () => {
    expect(normalizeRpId('  Login.Example.COM ')).toBe('login.example.com');
  });
});

describe('shouldIntercept', () => {
  it('follows the mode when nothing is excluded', () => {
    expect(shouldIntercept('example.com', rules('disabled'), [])).toBe(false);
    expect(shouldIntercept('example.com', rules('all'), [])).toBe(true);
    expect(shouldIntercept('example.com', rules('allowlist', ['example.com']), [])).toBe(true);
    expect(shouldIntercept('other.example', rules('allowlist', ['example.com']), [])).toBe(false);
    expect(shouldIntercept('example.com', rules('blocklist', ['example.com']), [])).toBe(false);
    expect(shouldIntercept('other.example', rules('blocklist', ['example.com']), [])).toBe(true);
  });

  it('matches mode rules by suffix', () => {
    const allow = rules('allowlist', ['Example.com']);
    expect(shouldIntercept('login.example.com', allow, [])).toBe(true);
    expect(shouldIntercept('notexample.com', allow, [])).toBe(false);
  });

  it.each(MODES)('leaves an excluded site to the browser in mode %s', (mode) => {
    // The site is on the allowlist (and off the blocklist) so the mode
    // alone would intercept it wherever it can.
    const domains = mode === 'blocklist' ? ['other.example'] : ['example.com'];
    expect(shouldIntercept('example.com', rules(mode, domains), ['example.com'])).toBe(false);
  });

  it('matches exclusions exactly, not by suffix', () => {
    const all = rules('all');
    expect(shouldIntercept('example.com', all, ['login.example.com'])).toBe(true);
    expect(shouldIntercept('login.example.com', all, ['login.example.com'])).toBe(false);
    expect(shouldIntercept('login.example.com', all, ['example.com'])).toBe(true);
    expect(shouldIntercept('example.com', all, ['example.com'])).toBe(false);
  });

  it('compares the RP ID case-insensitively with the stored (normalized) list', () => {
    expect(shouldIntercept(' Example.COM ', rules('all'), ['example.com'])).toBe(false);
  });

  it('ignores a domain list left over from another mode when every site is on', () => {
    const leftover = rules('all', ['example.com']);
    expect(shouldIntercept('other.example', leftover, [])).toBe(true);
    expect(shouldIntercept('example.com', leftover, [])).toBe(true);
  });
});

describe('loadInterceptionSettings', () => {
  const local = (window as unknown as { chrome: { storage: { local: { get: jest.Mock } } } }).chrome
    .storage.local;

  it('reads both settings and normalizes them', async () => {
    local.get.mockResolvedValueOnce({
      [DOMAIN_RULES_KEY]: {
        mode: 'blocklist',
        domains: ['a.example'],
        passthroughOnNoPasskey: false,
      },
      [EXCLUDED_SITES_KEY]: ['B.example', 'b.example'],
    });

    expect(await loadInterceptionSettings()).toEqual({
      rules: { mode: 'blocklist', domains: ['a.example'], passthroughOnNoPasskey: false },
      excluded: ['b.example'],
    });
    expect(local.get).toHaveBeenCalledWith([DOMAIN_RULES_KEY, EXCLUDED_SITES_KEY]);
  });

  it('defaults to every site and no exclusions when nothing is stored', async () => {
    local.get.mockResolvedValueOnce({});

    expect(await loadInterceptionSettings()).toEqual({
      rules: { mode: 'all', domains: [], passthroughOnNoPasskey: true },
      excluded: [],
    });
  });
});
