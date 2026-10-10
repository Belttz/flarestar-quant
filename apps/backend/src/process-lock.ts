import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

interface LockRecord {
  pid: number;
  token: string;
  createdAt: string;
  /**
   * Linux process start time: field 22 ("starttime", in clock ticks) of `/proc/<pid>/stat`.
   *
   * It is constant for the lifetime of a single process instance but differs for every new process
   * instance, so it identifies "this exact process run" rather than merely "some process that
   * currently owns this pid". That distinction is what makes stale-lock detection immune to pid
   * reuse (e.g. a container restart resetting the pid namespace and handing out the same low pids).
   *
   * Optional for backward compatibility with lock files written by older builds; also never
   * written on platforms where it cannot be observed (see {@link readLinuxProcessStartTime}).
   */
  processStartTime?: number;
}

export interface BackendProcessLock {
  readonly path: string;
  release(): void;
}

/** Options accepted by {@link acquireBackendProcessLock}. */
export interface AcquireBackendProcessLockOptions {
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  /**
   * Returns the start time (clock ticks) of the given pid, or `null` when it cannot be observed
   * (non-Linux host, `/proc` unavailable, or the pid does not exist). Injectable so the
   * liveness/identity logic can be tested deterministically.
   */
  readProcessStartTime?: (pid: number) => number | null;
}

/** How many exclusive-create attempts are made before giving up with `backend_lock_unavailable`. */
const MAX_ACQUIRE_ATTEMPTS = 3;

/**
 * Offset of the `starttime` field within the token list that follows the `comm` field in
 * `/proc/<pid>/stat`. Fields are 1-indexed; `comm` is field 2 and `state` is field 3 (the first
 * token after the closing parenthesis), so field 22 sits at 0-based offset 22 - 3 = 19.
 */
const PROC_STAT_STARTTIME_OFFSET = 19;

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Parses the `starttime` field (22, 1-indexed) from the raw contents of `/proc/<pid>/stat`.
 *
 * The second field (`comm`, the executable name) is wrapped in parentheses and may itself contain
 * spaces or parentheses, so we anchor on the last ')' and count tokens from there instead of a
 * naive whitespace split. Returns `null` when the field cannot be parsed.
 */
function parseStartTimeFromProcStat(stat: string): number | null {
  const closeParen = stat.lastIndexOf(')');
  if (closeParen < 0) return null;
  const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
  const startTime = Number.parseInt(fields[PROC_STAT_STARTTIME_OFFSET] ?? '', 10);
  return Number.isFinite(startTime) ? startTime : null;
}

/**
 * Reads the process start time for `pid`. Only Linux exposes this cheaply via `/proc`; on any other
 * platform (or when `/proc/<pid>/stat` is unreadable) it returns `null`, which makes the caller
 * degrade to legacy PID-only semantics. That downgrade is safe because pid-namespace resets — the
 * root cause this guards against — only exist on Linux.
 */
function readLinuxProcessStartTime(pid: number): number | null {
  if (process.platform !== 'linux') return null;
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    return parseStartTimeFromProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

function readLock(path: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Partial<LockRecord>;
    const pid = record.pid;
    const token = record.token;
    const createdAt = record.createdAt;
    if (
      typeof pid !== 'number' ||
      !Number.isInteger(pid) ||
      typeof token !== 'string' ||
      typeof createdAt !== 'string'
    ) {
      return null;
    }
    // `processStartTime` is intentionally optional: older builds never wrote it, and non-Linux
    // hosts never do. A present-but-invalid value is dropped (degrading to legacy PID semantics)
    // rather than discarding an otherwise valid record.
    const processStartTime =
      typeof record.processStartTime === 'number' && Number.isFinite(record.processStartTime)
        ? record.processStartTime
        : undefined;
    return {
      pid,
      token,
      createdAt,
      ...(processStartTime === undefined ? {} : { processStartTime }),
    };
  } catch {
    return null;
  }
}

type LockVerdict = 'stale' | 'live';

/**
 * Decides whether an existing on-disk lock is stale (safe to remove) or live (a real backend owns
 * it). The decision always favours safety: it reports `stale` only when it can prove the recorded
 * owner is gone, and never brands two genuinely concurrent processes as stale.
 */
function evaluateExistingLock(
  existing: LockRecord,
  acquiringPid: number,
  isProcessAlive: (pid: number) => boolean,
  readProcessStartTime: (pid: number) => number | null,
): LockVerdict {
  // A recorded pid that no longer exists is unambiguously a stale lock.
  if (!isProcessAlive(existing.pid)) return 'stale';

  const observedStartTime = readProcessStartTime(existing.pid);

  // Preferred path (Linux, /proc readable, record carries an identity): a still-live pid whose start
  // time differs from the recorded one is a *different* process that reused the pid after the
  // original owner died — exactly the container-restart scenario this fix targets. A matching start
  // time means the recorded owner is genuinely alive, so the lock is live and must be respected.
  if (observedStartTime !== null && existing.processStartTime !== undefined) {
    return observedStartTime === existing.processStartTime ? 'live' : 'stale';
  }

  // We cannot compare start times here: non-Linux host, `/proc` unreadable, or a legacy record that
  // predates `processStartTime`. A lock naming our *own* pid cannot be ours — we are only now trying
  // to acquire it, and a pid can only be reused after its previous owner died — so it is a leftover
  // from a recycled pid and therefore stale. This keeps the production incident self-healing without
  // a manual step, and it can never mis-brand a live foreign owner because two processes that are
  // truly running concurrently never share a pid.
  if (existing.pid === acquiringPid) return 'stale';

  // Anything else — a distinct, still-alive pid we cannot fingerprint — is treated as a live lock.
  // Removing ambiguous ownership could let two strategy engines race one database, so we refuse and
  // print actionable recovery guidance instead.
  return 'live';
}

function describeLock(existing: LockRecord): string {
  return JSON.stringify({
    pid: existing.pid,
    createdAt: existing.createdAt,
    processStartTime: existing.processStartTime ?? null,
  });
}

/**
 * Builds the error thrown when we refuse to acquire a lock we believe is live/ambiguous, and prints
 * operator guidance explaining how to recover. The error message keeps the `backend_already_running`
 * prefix that existing callers/tests rely on.
 */
function liveLockError(path: string, reason: string, cause: unknown): Error {
  console.error(
    `backend_already_running:${path}`,
    `${reason}. If you are certain no other backend is running (for example after an unclean ` +
      `container stop, host reboot or OOM kill left a stale lock behind), you may remove the lock ` +
      `file and restart: rm -f ${path}`,
  );
  return new Error(`backend_already_running:${path}`, { cause });
}

function createHandle(path: string, token: string): BackendProcessLock {
  let released = false;
  return {
    path,
    release: () => {
      if (released) return;
      released = true;
      const current = readLock(path);
      if (current?.token === token) {
        try {
          unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    },
  };
}

/**
 * Removes a lock we have already proven stale. We re-read immediately before unlinking and only
 * delete the exact record we assessed (same token); if it changed or became unreadable, another
 * process has already moved on and we leave the file untouched, letting the retry loop re-evaluate.
 * This narrows the TOCTOU window in which we could otherwise delete a freshly created, live lock. A
 * concurrent unlink that loses the race just sees ENOENT, which is ignored.
 */
function removeStaleLock(path: string, expectedToken: string): void {
  const current = readLock(path);
  if (!current || current.token !== expectedToken) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * The launcher is a convenience, not a safety boundary. This owner-only lock prevents two direct
 * `node dist/server.js`/Docker invocations from running strategy engines against one database.
 *
 * Staleness is decided by process identity (pid + process start time) rather than a bare pid, so a
 * lock left behind by a dead process is reclaimed even when a new process reuses the same pid after
 * a container restart resets the pid namespace.
 */
export function acquireBackendProcessLock(
  dataDirectory: string,
  options: AcquireBackendProcessLockOptions = {},
): BackendProcessLock {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  chmodSync(dataDirectory, 0o700);
  const path = join(dataDirectory, 'backend.lock');
  const pid = options.pid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? processExists;
  const readProcessStartTime = options.readProcessStartTime ?? readLinuxProcessStartTime;
  const token = randomUUID();
  const startTime = readProcessStartTime(pid);
  const record: LockRecord = {
    pid,
    token,
    createdAt: new Date().toISOString(),
    ...(startTime === null ? {} : { processStartTime: startTime }),
  };

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    let descriptor: number | null = null;
    try {
      // O_CREAT | O_EXCL is atomic: exactly one of N racing processes can create the file, so we
      // never assume ownership on the cleanup path — we always (re)create and let the kernel decide.
      descriptor = openSync(path, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
      closeSync(descriptor);
      descriptor = null;
      chmodSync(path, 0o600);
      return createHandle(path, token);
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;

      const existing = readLock(path);
      if (!existing) {
        // Unreadable, empty or corrupt lock: we cannot prove ownership, so keep the conservative
        // "treat as live" semantics (deleting ambiguous ownership could enable two trading
        // processes) but tell the operator exactly how to recover.
        throw liveLockError(path, 'the existing lock file is unreadable or corrupt', error);
      }

      if (evaluateExistingLock(existing, pid, isProcessAlive, readProcessStartTime) === 'live') {
        throw liveLockError(
          path,
          `another backend instance is still running (${describeLock(existing)})`,
          error,
        );
      }

      removeStaleLock(path, existing.token);
      // Loop and retry the exclusive create. If another process reclaimed the same stale lock first
      // and installed its own, our next `openSync(path, 'wx')` fails with EEXIST and the loop
      // re-reads a fresh, live lock and reports it correctly instead of assuming we won.
    }
  }
  throw new Error(`backend_lock_unavailable:${path}`);
}
