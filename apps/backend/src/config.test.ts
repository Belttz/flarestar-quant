import { describe, expect, it } from 'vitest';
import { loadConfig, localNetworkHosts, type HostAccessMode } from './config.js';

/** Minimal environment: everything else is derived, so only the knobs under test are set. */
function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    GCT_DATA_DIR: '/tmp/gate-crossex-config-test',
    ...extra,
  } as NodeJS.ProcessEnv;
}

describe('loadConfig host / origin access', () => {
  it('defaults to the loopback-first allowlist so a desktop install stays protected', () => {
    const config = loadConfig(env());
    expect(config.hostAccess).toBe('loopback');
    expect(config.trustAnyHost).toBe(false);
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect([...config.allowedHosts]).toContain(host);
    }
    // A reverse-proxy identity nobody configured must stay rejected — that is the DNS-rebinding
    // protection the whole allowlist exists for.
    expect(config.allowedHosts.has('attacker.example')).toBe(false);
    expect(config.allowedHosts.has('203.0.113.10')).toBe(false);
  });

  it('accepts loopback, lan and any modes and rejects anything else loudly', () => {
    const modes: Record<string, HostAccessMode> = {
      loopback: 'loopback',
      lan: 'lan',
      any: 'any',
      LAN: 'lan',
      ' local-network ': 'lan',
      public: 'any',
    };
    for (const [raw, expected] of Object.entries(modes)) {
      expect(loadConfig(env({ GCT_HOST_ACCESS: raw })).hostAccess).toBe(expected);
    }
    expect(() => loadConfig(env({ GCT_HOST_ACCESS: 'wildcard' }))).toThrow(/GCT_HOST_ACCESS/);
  });

  it('trusts every Host in any mode, which is what public-IP and domain access need', () => {
    const config = loadConfig(env({ GCT_HOST_ACCESS: 'any' }));
    expect(config.trustAnyHost).toBe(true);
    // The set is still reported for logging; the request gate short-circuits before consulting it.
    expect(config.allowedHosts.has('203.0.113.10')).toBe(false);
  });

  it('adds this machine\'s own LAN addresses in lan mode', () => {
    const config = loadConfig(env({ GCT_HOST_ACCESS: 'lan', GCT_HOST: '0.0.0.0' }));
    const detected = localNetworkHosts();
    for (const host of detected) {
      if (!host.includes(':')) expect([...config.allowedHosts]).toContain(host);
    }
    // Loopback stays allowed, and link-local noise never widens the set.
    expect(config.allowedHosts.has('127.0.0.1')).toBe(true);
    expect([...config.allowedHosts].some((host) => host.startsWith('169.254.'))).toBe(false);
    expect([...config.allowedHosts].some((host) => host.startsWith('fe80:'))).toBe(false);
  });

  it('admits explicitly configured hosts and derives their browser origins', () => {
    const config = loadConfig(env({
      GCT_ALLOWED_HOSTS: 'quant.example.com, 203.0.113.10 ',
      GCT_HOST: '127.0.0.1',
    }));
    expect(config.allowedHosts.has('quant.example.com')).toBe(true);
    expect(config.allowedHosts.has('203.0.113.10')).toBe(true);
    // Configuring a host used to be a dead end: the Origin check had no counterpart setting, so a
    // request could clear the Host gate and still be rejected as an unexpected origin.
    expect([...config.allowedOrigins]).toContain('https://quant.example.com');
    expect([...config.allowedOrigins]).toContain('http://203.0.113.10');
  });

  it('accepts several explicit origins at once', () => {
    const config = loadConfig(env({
      GCT_ALLOWED_ORIGINS: 'https://quant.example.com, http://192.168.1.20:8080',
    }));
    expect([...config.allowedOrigins]).toContain('https://quant.example.com');
    expect([...config.allowedOrigins]).toContain('http://192.168.1.20:8080');
  });

  it('treats the legacy GCT_ALLOWED_HOSTS=any token as any-mode', () => {
    const config = loadConfig(env({ GCT_ALLOWED_HOSTS: 'any' }));
    expect(config.hostAccess).toBe('any');
    expect(config.trustAnyHost).toBe(true);
    // The sentinel itself must not become a hostname somebody could present.
    expect(config.allowedHosts.has('any')).toBe(false);
  });

  it('admits the concrete address it listens on without extra configuration', () => {
    const concrete = loadConfig(env({ GCT_HOST: '192.168.1.20' }));
    expect(concrete.allowedHosts.has('192.168.1.20')).toBe(true);
    // A wildcard bind is not an identity: it must not widen the allowlist.
    const wildcard = loadConfig(env({ GCT_HOST: '0.0.0.0' }));
    expect(wildcard.allowedHosts.has('0.0.0.0')).toBe(false);
  });

  it('keeps the loopback trust domain regardless of mode', () => {
    for (const access of ['loopback', 'lan', 'any'] as const) {
      const config = loadConfig(env({ GCT_HOST_ACCESS: access }));
      expect([...config.allowedOrigins]).toContain('http://localhost:17840');
      expect([...config.allowedOrigins]).toContain('http://127.0.0.1:17840');
    }
  });

  it('treats a blank GCT_FRONTEND_ORIGIN as unset so IP-only deployments stay clean', () => {
    // Pure public-IP deployments leave the domain unset; compose then passes an empty string. That
    // must fall back to the loopback default rather than registering a bogus empty origin.
    for (const blank of ['', '   ']) {
      const config = loadConfig(env({ GCT_FRONTEND_ORIGIN: blank }));
      expect(config.allowedOrigin).toBe('http://127.0.0.1:5173');
      expect([...config.allowedOrigins]).not.toContain('');
    }
    const configured = loadConfig(env({ GCT_FRONTEND_ORIGIN: ' https://quant.example.com ' }));
    expect(configured.allowedOrigin).toBe('https://quant.example.com');
    expect([...configured.allowedOrigins]).toContain('https://quant.example.com');
  });
});
