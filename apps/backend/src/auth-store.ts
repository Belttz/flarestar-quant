import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Cloud-deployment authentication primitives: scrypt password hashing against
 * the single-row `auth_user` SQLite table, an in-memory bearer-session store
 * backed by an HttpOnly cookie, and a per-IP login failure throttle.
 *
 * Plaintext passwords never touch SQLite, logs, or the frontend.
 */

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1 } as const;

export function hashPassword(password: string, salt: string = randomBytes(16).toString('base64url')): { salt: string; hash: string } {
  const hash = scryptSync(password.normalize('NFKC'), salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS).toString('base64url');
  return { salt, hash };
}

export function verifyPasswordHash(password: string, salt: string, expectedHash: string): boolean {
  try {
    const actual = scryptSync(password.normalize('NFKC'), salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);
    const expected = Buffer.from(expectedHash, 'base64url');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

interface AuthUserRow {
  id: number;
  username: string;
  password_hash: string;
  password_salt: string;
}

export class AuthUserStore {
  constructor(private readonly database: Database.Database) {}

  /**
   * Seeds the operator account exactly once; later boots keep the stored (possibly changed)
   * password. Returns true only when this call performed the seeding — the caller uses that to
   * print a generated bootstrap password exactly once, to the log and nowhere persistent.
   */
  ensureSeeded(username: string, password: string): boolean {
    const existing = this.row();
    if (existing) return false;
    const { salt, hash } = hashPassword(password);
    this.database.prepare(`
      INSERT INTO auth_user (id, username, password_hash, password_salt, updated_at)
      VALUES (1, ?, ?, ?, ?)
    `).run(username, hash, salt, new Date().toISOString());
    return true;
  }

  username(): string | null {
    return this.row()?.username ?? null;
  }

  /** Returns false for unknown usernames with the same latency shape as a hash check (no user enumeration). */
  verify(username: string, password: string): boolean {
    const row = this.row();
    if (!row) return false;
    if (row.username !== username) {
      // Burn comparable CPU so response timing does not reveal whether the username exists.
      hashPassword(password, row.password_salt);
      return false;
    }
    return verifyPasswordHash(password, row.password_salt, row.password_hash);
  }

  updatePassword(newPassword: string): void {
    const row = this.row();
    if (!row) throw new Error('auth user is not seeded');
    const { salt, hash } = hashPassword(newPassword);
    this.database.prepare(`
      UPDATE auth_user SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = 1
    `).run(hash, salt, new Date().toISOString());
  }

  private row(): AuthUserRow | undefined {
    return this.database.prepare('SELECT id, username, password_hash, password_salt FROM auth_user WHERE id = 1').get() as AuthUserRow | undefined;
  }
}

export const SESSION_COOKIE_NAME = 'gct_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_SESSIONS = 64;

/** In-memory bearer sessions; a backend restart signs every browser out on purpose. */
export class AuthSessionStore {
  private readonly sessions = new Map<string, number>();

  constructor(
    private readonly ttlMs = SESSION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  issue(): string {
    this.removeExpired();
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((left, right) => left[1] - right[1])[0]?.[0];
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, this.now() + this.ttlMs);
    return token;
  }

  validate(token: string): boolean {
    const expiresAt = this.sessions.get(token);
    if (!expiresAt) return false;
    if (expiresAt < this.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  revoke(token: string): void {
    this.sessions.delete(token);
  }

  revokeAllExcept(keepToken: string | null): void {
    for (const token of this.sessions.keys()) {
      if (token !== keepToken) this.sessions.delete(token);
    }
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [token, expiresAt] of this.sessions) {
      if (expiresAt < now) this.sessions.delete(token);
    }
  }
}

interface ThrottleState {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

const FAILURE_WINDOW_MS = 15 * 60_000;
const LOCKOUT_MS = 15 * 60_000;

/** Per-IP brute-force guard: 5 failures in 15 minutes lock logins for 15 minutes. */
export class LoginThrottle {
  private readonly attempts = new Map<string, ThrottleState>();

  constructor(
    private readonly maxFailures = 5,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const state = this.attempts.get(key);
    const now = this.now();
    if (!state) return { allowed: true, retryAfterSeconds: 0 };
    if (state.lockedUntil > now) {
      return { allowed: false, retryAfterSeconds: Math.ceil((state.lockedUntil - now) / 1_000) };
    }
    if (now - state.windowStart > FAILURE_WINDOW_MS) this.attempts.delete(key);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  recordFailure(key: string): void {
    const now = this.now();
    const state = this.attempts.get(key);
    if (!state || now - state.windowStart > FAILURE_WINDOW_MS) {
      this.attempts.set(key, { failures: 1, windowStart: now, lockedUntil: 0 });
      return;
    }
    state.failures += 1;
    if (state.failures >= this.maxFailures) {
      state.lockedUntil = now + LOCKOUT_MS;
      state.failures = 0;
      state.windowStart = now;
    }
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }
}
