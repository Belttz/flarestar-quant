import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildIsFresh, needsBuild } from './build-fresh.mjs';

/** Create a file whose mtime is pinned to the given epoch seconds. */
function touch(baseDir, relativePath, epochSeconds) {
  const path = join(baseDir, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'x');
  utimesSync(path, epochSeconds, epochSeconds);
  return path;
}

function workspace() {
  return mkdtempSync(join(tmpdir(), 'gct-build-fresh-'));
}

test('buildIsFresh: fresh outputs newer than all sources are skipped', () => {
  const dir = workspace();
  const source = touch(dir, 'src/index.ts', 1_000);
  const output = touch(dir, 'dist/index.js', 2_000);
  assert.equal(buildIsFresh([output], [join(dir, 'src')], []), true);
  assert.equal(needsBuild([output], [join(dir, 'src')], [source]), false);
});

test('buildIsFresh: a newer source file forces a rebuild', () => {
  const dir = workspace();
  touch(dir, 'src/index.ts', 3_000);
  const output = touch(dir, 'dist/index.js', 2_000);
  assert.equal(buildIsFresh([output], [join(dir, 'src')], []), false);
  assert.equal(needsBuild([output], [join(dir, 'src')], []), true);
});

test('buildIsFresh: missing outputs force a rebuild', () => {
  const dir = workspace();
  touch(dir, 'src/index.ts', 1_000);
  touch(dir, 'dist/other.js', 2_000);
  assert.equal(buildIsFresh([join(dir, 'dist', 'index.js')], [join(dir, 'src')], []), false);
});

test('needsBuild: the force flag rebuilds even when outputs are fresh', () => {
  const dir = workspace();
  const output = touch(dir, 'dist/index.js', 5_000);
  assert.equal(needsBuild([output], [join(dir, 'src')], [], true), true);
  // Without the flag the same state stays fresh (the source directory is empty here).
  assert.equal(needsBuild([output], [join(dir, 'src')], [], false), false);
});

test('buildIsFresh: rebuilt package artifacts cascade into downstream stages', () => {
  const dir = workspace();
  const packageDist = touch(dir, 'packages/shared-types/dist/index.js', 4_000);
  touch(dir, 'apps/backend/src/server.ts', 1_000);
  const backendOutput = touch(dir, 'apps/backend/dist/server.js', 2_000);
  // The backend output predates the fresh package artifact counted among its inputs.
  assert.equal(
    buildIsFresh([backendOutput], [join(dir, 'apps/backend/src')], [packageDist]),
    false,
  );
  // Once the downstream output is rebuilt after the package artifact, the stage is fresh.
  const rebuilt = touch(dir, 'apps/backend/dist/server.js', 5_000);
  assert.equal(
    buildIsFresh([rebuilt], [join(dir, 'apps/backend/src')], [packageDist]),
    true,
  );
});

test('QA supplement v2: buildIsFresh honors the 1s clock-skew slack boundary', () => {
  const dir = workspace();
  // Source edited at t=2000s; the output is compared against (2000s − 1s).
  touch(dir, 'src/index.ts', 2_000);
  // 200s older than the source → stale.
  const stale = touch(dir, 'dist/index.js', 1_800);
  assert.equal(buildIsFresh([stale], [join(dir, 'src')], []), false);
  // Exactly 1s older → inside the slack → still fresh (inclusive boundary).
  const within = touch(dir, 'dist/index.js', 1_999);
  assert.equal(buildIsFresh([within], [join(dir, 'src')], []), true);
  // 2s older → outside the slack → rebuild.
  const beyond = touch(dir, 'dist/index.js', 1_998);
  assert.equal(buildIsFresh([beyond], [join(dir, 'src')], []), false);
});
