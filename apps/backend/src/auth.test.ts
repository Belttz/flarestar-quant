import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';

// scrypt password hashing is deliberately expensive; under parallel suite load a
// single test can chain several verifies, so lift the per-test ceiling.
vi.setConfig({ testTimeout: 30_000 });
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { PublicMarketDataGateway } from '@gate-crossex/public-data';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase, prepareDatabaseForClose } from './database.js';
import { MemoryCredentialVault } from './credential-vault.js';
import type { TradingCrossExGateway } from './crossex-client.js';

interface AuthTestContext {
  app: FastifyInstance;
  database: Database.Database;
  directory: string;
  close: () => Promise<void>;
}

const contexts: AuthTestContext[] = [];

async function buildAuthApp(): Promise<AuthTestContext> {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-auth-'));
  // The bootstrap credential is always injected explicitly: config no longer ships a default
  // password, so a test that relied on one would silently drift from real deployments.
  const config = loadConfig({
    GCT_DATA_DIR: directory,
    GCT_MIGRATIONS_DIR: resolve(process.cwd(), '../../migrations'),
    GCT_AUTH_USERNAME: 'Belttz',
    GCT_AUTH_PASSWORD: 'test-seed-pass-42',
  });
  const database = openDatabase(config.databasePath, config.migrationsDir);
  const app = await buildApp({
    config,
    database,
    credentialVault: new MemoryCredentialVault(),
    crossExGateway: {} as TradingCrossExGateway,
    publicMarketGateway: {} as PublicMarketDataGateway,
    logger: false,
  });
  const context: AuthTestContext = {
    app,
    database,
    directory,
    close: async () => {
      await app.close();
      prepareDatabaseForClose(database);
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});

const LOGIN = { username: 'Belttz', password: 'test-seed-pass-42' };

async function login(app: FastifyInstance, body: Record<string, string> = LOGIN): Promise<string | null> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: body });
  if (response.statusCode !== 200) return null;
  const cookie = response.cookies.find((candidate) => candidate.name === 'gct_session');
  return cookie ? `${cookie.name}=${cookie.value}` : null;
}

describe('operator authentication gate', () => {
  it('rejects API access without a session while keeping /health public', async () => {
    const { app } = await buildAuthApp();

    const markets = await app.inject({ method: 'GET', url: '/api/markets' });
    expect(markets.statusCode).toBe(401);
    expect(markets.json()).toEqual({ error: 'unauthenticated' });

    const session = await app.inject({ method: 'GET', url: '/api/auth/session' });
    expect(session.statusCode).toBe(401);

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
  });

  it('rejects wrong passwords and unknown usernames with the same error', async () => {
    const { app } = await buildAuthApp();

    const wrongPassword = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { username: LOGIN.username, password: 'wrong-password' },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual({ error: 'invalid_credentials' });

    const wrongUsername = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { username: 'SomebodyElse', password: LOGIN.password },
    });
    expect(wrongUsername.statusCode).toBe(401);
    expect(wrongUsername.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('issues a session cookie that unlocks the API and the session endpoint', async () => {
    const { app } = await buildAuthApp();
    const cookie = await login(app);
    expect(cookie).toMatch(/^gct_session=/);

    const session = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: cookie! } });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ authenticated: true, username: 'Belttz' });

    const markets = await app.inject({ method: 'GET', url: '/api/markets', headers: { cookie: cookie! } });
    expect(markets.statusCode).toBe(200);

    const wsGuard = await app.inject({ method: 'GET', url: '/ws/stream' });
    expect(wsGuard.statusCode).toBe(401);
  });

  it('sets the session cookie with hardened attributes', async () => {
    const { app } = await buildAuthApp();
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: LOGIN });
    expect(response.statusCode).toBe(200);
    const cookieHeader = response.headers['set-cookie'];
    const raw = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    expect(String(raw)).toContain('HttpOnly');
    expect(String(raw)).toContain('SameSite=Strict');
    expect(String(raw)).toContain('Max-Age=');
  });

  it('changes the password, keeps the current session, and invalidates the old password', async () => {
    const { app } = await buildAuthApp();
    const cookie = await login(app);

    const wrongCurrent = await app.inject({
      method: 'POST', url: '/api/auth/change-password',
      headers: { cookie: cookie! },
      payload: { currentPassword: 'not-it', newPassword: 'Fresh-Pass-99' },
    });
    expect(wrongCurrent.statusCode).toBe(401);
    expect(wrongCurrent.json()).toEqual({ error: 'invalid_current_password' });

    const tooShort = await app.inject({
      method: 'POST', url: '/api/auth/change-password',
      headers: { cookie: cookie! },
      payload: { currentPassword: LOGIN.password, newPassword: 'ab1' },
    });
    expect(tooShort.statusCode).toBe(400);
    expect(tooShort.json()).toEqual({ error: 'new_password_too_short' });

    const weak = await app.inject({
      method: 'POST', url: '/api/auth/change-password',
      headers: { cookie: cookie! },
      payload: { currentPassword: LOGIN.password, newPassword: 'nodigitsatall' },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json()).toEqual({ error: 'new_password_weak' });

    const changed = await app.inject({
      method: 'POST', url: '/api/auth/change-password',
      headers: { cookie: cookie! },
      payload: { currentPassword: LOGIN.password, newPassword: 'Fresh-Pass-99' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ ok: true });

    const oldLogin = await login(app);
    expect(oldLogin).toBeNull();

    const newLogin = await login(app, { username: LOGIN.username, password: 'Fresh-Pass-99' });
    expect(newLogin).toMatch(/^gct_session=/);

    // The session that performed the change survives; fresh logins get a new token.
    const stillValid = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: cookie! } });
    expect(stillValid.statusCode).toBe(200);
  });

  it('locks repeated login failures before allowing another attempt', async () => {
    const { app } = await buildAuthApp();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await app.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { username: LOGIN.username, password: `bad-${attempt}` },
      });
      expect(failed.statusCode).toBe(401);
    }
    const locked = await app.inject({ method: 'POST', url: '/api/auth/login', payload: LOGIN });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toBe('login_attempts_exceeded');
    expect(locked.headers['retry-after']).toBeDefined();
  });

  it('revokes the session on logout', async () => {
    const { app } = await buildAuthApp();
    const cookie = await login(app);
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: cookie! } });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await app.inject({ method: 'GET', url: '/api/markets', headers: { cookie: cookie! } });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('rejects unauthenticated password changes', async () => {
    const { app } = await buildAuthApp();
    const response = await app.inject({
      method: 'POST', url: '/api/auth/change-password',
      payload: { currentPassword: LOGIN.password, newPassword: 'Fresh-Pass-99' },
    });
    expect(response.statusCode).toBe(401);
  });
});
