import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireBackendProcessLock } from './process-lock.js';

const directories: string[] = [];

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gct-lock-'));
  directories.push(directory);
  return directory;
}

/** Writes a raw lock file so tests can fabricate legacy/corrupt/foreign on-disk states. */
function writeRawLock(directory: string, content: string): string {
  const path = join(directory, 'backend.lock');
  writeFileSync(path, content, 'utf8');
  return path;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('backend process lock', () => {
  it('rejects a second live owner and releases only its own token', () => {
    const directory = makeDirectory();
    const first = acquireBackendProcessLock(directory, { pid: 101, isProcessAlive: (pid) => pid === 101 });
    expect(() => acquireBackendProcessLock(directory, { pid: 202, isProcessAlive: (pid) => pid === 101 }))
      .toThrow(/backend_already_running/);
    if (process.platform !== 'win32') {
      expect(statSync(first.path).mode & 0o777).toBe(0o600);
    }
    first.release();
    const second = acquireBackendProcessLock(directory, { pid: 202, isProcessAlive: () => false });
    expect(JSON.parse(readFileSync(second.path, 'utf8'))).toMatchObject({ pid: 202 });
    second.release();
  });

  it('replaces a stale lock', () => {
    const directory = makeDirectory();
    const stale = acquireBackendProcessLock(directory, { pid: 101, isProcessAlive: () => false });
    // Do not release: the second acquisition should prove the recorded pid is stale and replace it.
    const replacement = acquireBackendProcessLock(directory, { pid: 202, isProcessAlive: () => false });
    stale.release();
    expect(JSON.parse(readFileSync(replacement.path, 'utf8'))).toMatchObject({ pid: 202 });
    replacement.release();
  });

  // Regression for the production incident: a container restart resets the pid namespace, so the
  // new backend reuses the pid recorded by the dead previous instance. The lock must be recognised
  // as stale via the mismatching process start time and reclaimed.
  it('replaces a lock whose pid matches ours but whose start time differs (pid reuse)', () => {
    const directory = makeDirectory();
    writeRawLock(
      directory,
      `${JSON.stringify({ pid: 777, token: 'dead-owner', createdAt: '2026-01-01T00:00:00.000Z', processStartTime: 1111 })}\n`,
    );

    const reclaimed = acquireBackendProcessLock(directory, {
      pid: 777,
      isProcessAlive: (pid) => pid === 777,
      // The live pid 777 is a *different* process instance than the recorded one.
      readProcessStartTime: () => 4242,
    });

    expect(JSON.parse(readFileSync(reclaimed.path, 'utf8'))).toMatchObject({
      pid: 777,
      processStartTime: 4242,
    });
    reclaimed.release();
  });

  it('still rejects a live owner with an identical process start time', () => {
    const directory = makeDirectory();
    writeRawLock(
      directory,
      `${JSON.stringify({ pid: 888, token: 'live-owner', createdAt: '2026-01-01T00:00:00.000Z', processStartTime: 5000 })}\n`,
    );

    expect(() =>
      acquireBackendProcessLock(directory, {
        pid: 999,
        isProcessAlive: (pid) => pid === 888,
        readProcessStartTime: () => 5000,
      }),
    ).toThrow(/backend_already_running/);
  });

  it('handles a legacy lock without processStartTime without crashing', () => {
    // Legacy record naming a *different*, still-alive pid we cannot fingerprint: stay conservative.
    const liveDirectory = makeDirectory();
    const livePath = writeRawLock(
      liveDirectory,
      `${JSON.stringify({ pid: 777, token: 'legacy', createdAt: '2026-01-01T00:00:00.000Z' })}\n`,
    );
    expect(() =>
      acquireBackendProcessLock(liveDirectory, {
        pid: 888,
        isProcessAlive: (pid) => pid === 777,
        readProcessStartTime: () => null,
      }),
    ).toThrow(/backend_already_running/);
    expect(existsSync(livePath)).toBe(true);

    // Legacy record naming our own pid cannot be ours, so it is treated as a recycled-pid leftover.
    const staleDirectory = makeDirectory();
    const reclaimed = acquireBackendProcessLock(staleDirectory, {
      pid: 777,
      isProcessAlive: (pid) => pid === 777,
      readProcessStartTime: () => null,
    });
    expect(JSON.parse(readFileSync(reclaimed.path, 'utf8'))).toMatchObject({ pid: 777 });
    reclaimed.release();
  });

  it('keeps a corrupt lock (conservative) and prints recovery guidance', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const directory = makeDirectory();
      const path = writeRawLock(directory, '{ this is not valid json');

      expect(() =>
        acquireBackendProcessLock(directory, { pid: 777, isProcessAlive: () => true }),
      ).toThrow(/backend_already_running/);

      // The lock must not be deleted and the operator must be told how to recover.
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('{ this is not valid json');
      const logged = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).toContain(path);
      expect(logged).toContain('rm -f');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('treats a lock missing its pid field as corrupt and conservatively keeps it', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const directory = makeDirectory();
      const path = writeRawLock(
        directory,
        `${JSON.stringify({ token: 'no-pid', createdAt: '2026-01-01T00:00:00.000Z' })}\n`,
      );

      expect(() =>
        acquireBackendProcessLock(directory, { pid: 777, isProcessAlive: () => true }),
      ).toThrow(/backend_already_running/);
      expect(existsSync(path)).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('falls back to PID-only judgement when the start time is unobservable (non-Linux)', () => {
    // A live foreign pid without any start time: still rejected (never delete a live lock).
    const liveDirectory = makeDirectory();
    const livePath = writeRawLock(
      liveDirectory,
      `${JSON.stringify({ pid: 500, token: 'foreign', createdAt: '2026-01-01T00:00:00.000Z' })}\n`,
    );
    expect(() =>
      acquireBackendProcessLock(liveDirectory, {
        pid: 600,
        isProcessAlive: (pid) => pid === 500,
        readProcessStartTime: () => null,
      }),
    ).toThrow(/backend_already_running/);
    expect(existsSync(livePath)).toBe(true);

    // A dead pid: reclaimed exactly as before.
    const staleDirectory = makeDirectory();
    const stalePath = writeRawLock(
      staleDirectory,
      `${JSON.stringify({ pid: 500, token: 'dead', createdAt: '2026-01-01T00:00:00.000Z' })}\n`,
    );
    const reclaimed = acquireBackendProcessLock(staleDirectory, {
      pid: 600,
      isProcessAlive: () => false,
      readProcessStartTime: () => null,
    });
    expect(JSON.parse(readFileSync(reclaimed.path, 'utf8'))).toMatchObject({ pid: 600 });
    expect(reclaimed.path).toBe(stalePath);
    reclaimed.release();
  });
});
