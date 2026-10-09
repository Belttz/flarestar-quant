import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

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
  authUsername: string;
  authBootstrapPassword: string;
  gateRestBaseUrl: string;
  gatePublicWebSocketUrl: string;
  gatePrivateWebSocketUrl: string;
}

function parsePort(value: string, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): BackendConfig {
  const host = environment.GCT_HOST ?? '127.0.0.1';
  const port = parsePort(environment.PORT ?? environment.GCT_PORT ?? '17840', 'GCT_PORT');
  const frontendPort = parsePort(environment.GCT_FRONTEND_PORT ?? '5173', 'GCT_FRONTEND_PORT');
  const dataDir = resolve(environment.GCT_DATA_DIR ?? join(projectRoot, '.local-data'));
  const configuredHosts = (environment.GCT_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  const allowedOrigin = environment.GCT_FRONTEND_ORIGIN ?? `http://127.0.0.1:${frontendPort}`;
  // Browsers send the loopback host the user actually typed; localhost, 127.0.0.1, and [::1]
  // variants of the local UI and backend are all the same trust domain.
  const loopbackOrigins = [frontendPort, port].flatMap((loopbackPort) => [
    `http://127.0.0.1:${loopbackPort}`,
    `http://localhost:${loopbackPort}`,
    `http://[::1]:${loopbackPort}`,
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
    allowedOrigins: new Set([allowedOrigin, ...loopbackOrigins]),
    allowedHosts: new Set(['127.0.0.1', 'localhost', '::1', ...configuredHosts]),
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
