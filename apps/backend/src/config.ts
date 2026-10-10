import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * How permissive the Host / Origin gate is. Every mode rejects any browser origin that is not
 * explicitly trusted: only the loopback origin set, whatever the operator configures, and requests
 * whose Origin matches the Host header they arrived on get through. The session cookie is
 * `SameSite=Strict` and CORS runs with `credentials: false`. The modes only decide *which DNS
 * identities the operator accepts as "my app"*.
 *
 * - `loopback` (default): desktop installs. Only loopback names plus explicitly configured hosts.
 *   Rejecting anything else is what stops DNS-rebinding attacks against a local instance.
 * - `lan`: additionally accepts this machine's own LAN addresses, so a phone on the same network
 *   can open the UI without editing the allowlist.
 * - `any`: server deployments. Public IP, a custom domain, a load-balancer hostname and the LAN
 *   address all work without pinning one of them. This is deliberately opt-in: the residual risk
 *   is DNS rebinding against an instance that is already intentionally exposed, never a silent
 *   widening of the default desktop posture.
 */
export type HostAccessMode = 'loopback' | 'lan' | 'any';

export interface BackendConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  credentialEnvPath: string;
  migrationsDir: string;
  frontendDistPath: string;
  allowedOrigin: string;
  allowedOrigins: ReadonlySet<string>;
  allowedHosts: ReadonlySet<string>;
  /** `loopback | lan | any` — see `HostAccessMode`. */
  hostAccess: HostAccessMode;
  /** True when the Host allowlist is bypassed entirely (`any` mode). Untrusted origins are still rejected. */
  trustAnyHost: boolean;
  authUsername: string;
  authBootstrapPassword: string;
  gateRestBaseUrl: string;
  gatePublicWebSocketUrl: string;
  gatePrivateWebSocketUrl: string;
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const;
/** Values that mean "accept whatever address the user reached this instance at". */
const ANY_HOST_TOKENS = ['any', 'all', '*'] as const;
const HOST_ACCESS_MODES: readonly HostAccessMode[] = ['loopback', 'lan', 'any'];

function parsePort(value: string, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** Strip an IPv6 zone index (`fe80::1%eth0` → `fe80::1`) so comparison against a Host header works. */
function normalizeHostToken(value: string): string {
  const zoneIndex = value.indexOf('%');
  return (zoneIndex === -1 ? value : value.slice(0, zoneIndex)).replace(/^\[|\]$/g, '');
}

function parseHostAccess(value: string | undefined): HostAccessMode {
  if (value === undefined) return 'loopback';
  const mode = value.trim().toLowerCase();
  if (mode === '') return 'loopback';
  if (mode === 'public') return 'any';
  if (mode === 'local-network' || mode === 'private') return 'lan';
  if ((HOST_ACCESS_MODES as readonly string[]).includes(mode)) return mode as HostAccessMode;
  // Fail loudly: falling back to the strict mode would re-create the very problem this knob
  // exists to solve (a silently unreachable server), while falling back to `any` would silently
  // widen the attack surface.
  throw new Error(`GCT_HOST_ACCESS must be one of ${HOST_ACCESS_MODES.join(', ')}`);
}

/** `http://host` / `https://host` pair for every configured host so one env var is enough. */
function originsFromHosts(hosts: readonly string[]): string[] {
  return hosts.flatMap((host) => [`http://${host}`, `https://${host}`]);
}

/**
 * This machine's own non-loopback addresses, i.e. the hosts a browser on the same network can use
 * to reach it. Link-local IPv6 (fe80::/10) and IPv4 automatic addresses (169.254/16) are dropped:
 * they are never typed into a browser and only widen the accepted Host set.
 */
export function localNetworkHosts(): string[] {
  const families = networkInterfaces();
  const hosts = new Set<string>();
  for (const entries of Object.values(families)) {
    for (const entry of entries ?? []) {
      if (!entry || entry.internal) continue;
      const address = normalizeHostToken(String(entry.address ?? '').toLowerCase());
      if (!address) continue;
      if (address.startsWith('fe80:') || address.startsWith('169.254.')) continue;
      hosts.add(address);
    }
  }
  return [...hosts];
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): BackendConfig {
  const host = environment.GCT_HOST ?? '127.0.0.1';
  const port = parsePort(environment.PORT ?? environment.GCT_PORT ?? '17840', 'GCT_PORT');
  const frontendPort = parsePort(environment.GCT_FRONTEND_PORT ?? '5173', 'GCT_FRONTEND_PORT');
  const dataDir = resolve(environment.GCT_DATA_DIR ?? join(projectRoot, '.local-data'));
  const configuredHosts = splitCsv(environment.GCT_ALLOWED_HOSTS)
    .map(normalizeHostToken)
    .filter(Boolean);
  // Comma-separated counterpart of GCT_FRONTEND_ORIGIN (which takes exactly one value).
  // Deployments served over several identities — a domain, the raw public IP and a LAN address —
  // can admit all of them at once instead of pinning whichever one happened to be configured.
  const configuredOrigins = splitCsv(environment.GCT_ALLOWED_ORIGINS);

  // `GCT_ALLOWED_HOSTS=any` predates GCT_HOST_ACCESS and must keep working for old cloud.env files.
  const hostAccess = ANY_HOST_TOKENS.some((token) => configuredHosts.includes(token))
    ? 'any'
    : parseHostAccess(environment.GCT_HOST_ACCESS);
  const trustAnyHost = hostAccess === 'any';

  // An empty/whitespace value means "not configured" — deployments that leave the domain unset
  // (pure public-IP access) then fall back to the loopback default instead of registering a bogus
  // empty origin. Same-origin requests are admitted by the Host header regardless, so this is safe.
  const configuredFrontendOrigin = environment.GCT_FRONTEND_ORIGIN?.trim();
  const allowedOrigin = configuredFrontendOrigin
    ? configuredFrontendOrigin
    : `http://127.0.0.1:${frontendPort}`;
  // Browsers send the loopback host the user actually typed; localhost, 127.0.0.1, and [::1]
  // variants of the local UI and backend are all the same trust domain.
  const loopbackOrigins = [frontendPort, port].flatMap((loopbackPort) => [
    `http://127.0.0.1:${loopbackPort}`,
    `http://localhost:${loopbackPort}`,
    `http://[::1]:${loopbackPort}`,
  ]);

  const extraOrigins = [
    ...configuredOrigins,
    // Configuring a host must also admit the browsers that reach it over http/https, so the two
    // settings cannot drift out of sync the way a host-only allowlist did.
    ...originsFromHosts(configuredHosts),
  ];
  const allowedOrigins = new Set([allowedOrigin, ...loopbackOrigins, ...extraOrigins]);

  // The address the process actually binds: when it is concrete (not a wildcard) requests aimed at
  // it are definitionally requests aimed at this instance, so it needs no separate allowlisting.
  const listenHostSource = trustAnyHost ? [] : [normalizeHostToken(host)];
  const allowedHosts = new Set([
    ...LOOPBACK_HOSTS,
    ...configuredHosts.filter((entry) => !ANY_HOST_TOKENS.includes(entry as typeof ANY_HOST_TOKENS[number])),
    ...listenHostSource.filter((entry) => entry !== '0.0.0.0' && entry !== '::' && entry !== ''),
    ...(hostAccess === 'lan' ? localNetworkHosts() : []),
  ]);

  return {
    host,
    port,
    dataDir,
    databasePath: join(dataDir, 'gate-crossex.sqlite'),
    credentialEnvPath: resolve(environment.GCT_CREDENTIAL_ENV_PATH ?? join(projectRoot, '.env')),
    migrationsDir: resolve(environment.GCT_MIGRATIONS_DIR ?? join(projectRoot, 'migrations')),
    frontendDistPath: resolve(environment.GCT_FRONTEND_DIST_DIR ?? join(projectRoot, 'apps/frontend/dist')),
    allowedOrigin,
    allowedOrigins,
    allowedHosts,
    hostAccess,
    trustAnyHost,
    // Operator login for cloud deployments. Only used to seed the auth_user table on the very
    // first boot; afterwards the password lives as a scrypt hash in SQLite and is changed via
    // the UI (POST /api/auth/change-password). Override before first boot with GCT_AUTH_USERNAME
    // / GCT_AUTH_PASSWORD.
    authUsername: environment.GCT_AUTH_USERNAME ?? 'Belttz',
    authBootstrapPassword: environment.GCT_AUTH_PASSWORD ?? '2636489471@Be',
    gateRestBaseUrl: environment.GCT_GATE_REST_URL ?? 'https://api.gateio.ws/api/v4',
    gatePublicWebSocketUrl: environment.GCT_GATE_PUBLIC_WS_URL ?? 'wss://api.gateio.ws/ws/crossex/public',
    gatePrivateWebSocketUrl: environment.GCT_GATE_PRIVATE_WS_URL ?? 'wss://api.gateio.ws/ws/crossex',
  };
}
