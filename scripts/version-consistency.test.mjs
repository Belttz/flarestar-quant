/**
 * Version-consistency regression tests.
 *
 * These guard the release chain against the exact drift that used to break the
 * official bundle: workspace manifests and `@gate-crossex/*` dependency ranges
 * silently diverging from the root version, and the server-only `cloud.env`
 * (domain + login password) accidentally becoming trackable.
 *
 * Run with: `node --test scripts/version-consistency.test.mjs` (or `npm run test:version`).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { expandWorkspaces, planSync } from './sync-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const rootVersion = rootManifest.version;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * Read a workspace manifest.
 *
 * @param {string} directory POSIX-style workspace directory, e.g. `apps/backend`.
 * @returns {Record<string, unknown>} Parsed manifest.
 */
function readManifest(directory) {
  return JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8'));
}

/**
 * Ask git whether a path is ignored.
 *
 * @param {string} relativePath Repository-relative path.
 * @returns {boolean} True when git reports the path as ignored.
 */
function isIgnored(relativePath) {
  const result = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--', relativePath]);
  if (result.error) throw result.error;
  return result.status === 0;
}

test('every workspace manifest is pinned to the root version', () => {
  const errors = [];
  const directories = expandWorkspaces(root, rootManifest.workspaces, errors);
  assert.deepEqual(errors, [], `workspace discovery failed: ${errors.join('; ')}`);
  assert.ok(directories.length >= 5, `expected at least 5 workspaces, discovered ${directories.length}`);
  for (const directory of directories) {
    const manifest = readManifest(directory);
    assert.equal(manifest.version, rootVersion, `${directory}/package.json version must equal root ${rootVersion}`);
  }
});

test('every @gate-crossex/* dependency range equals the root version', () => {
  const errors = [];
  const directories = expandWorkspaces(root, rootManifest.workspaces, errors);
  assert.deepEqual(errors, [], `workspace discovery failed: ${errors.join('; ')}`);
  let checked = 0;
  for (const directory of directories) {
    const manifest = readManifest(directory);
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = manifest[field];
      if (!dependencies || typeof dependencies !== 'object') continue;
      for (const [name, range] of Object.entries(dependencies)) {
        if (!name.startsWith('@gate-crossex/')) continue;
        checked += 1;
        assert.equal(range, rootVersion, `${directory}/package.json ${field}.${name} must equal ${rootVersion}`);
      }
    }
  }
  assert.ok(checked > 0, 'expected at least one @gate-crossex/* dependency to verify');
});

test('the sync plan reports no drift across manifests and the lockfile', () => {
  const plan = planSync(root);
  assert.deepEqual(plan.errors, [], `structural problems: ${plan.errors.join('; ')}`);
  const drift = plan.changes.map((change) => `${change.file}: ${change.description} ${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}`);
  assert.deepEqual(drift, [], `version drift detected: ${drift.join('; ')}`);
  assert.equal(plan.version, rootVersion);
});

test('.gitignore declares the root-anchored cloud.env rules', () => {
  const rules = readFileSync(join(root, '.gitignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim());
  assert.ok(rules.includes('/cloud.env'), '.gitignore must contain the root-anchored rule "/cloud.env"');
  assert.ok(rules.includes('/cloud.env.*'), '.gitignore must contain the root-anchored rule "/cloud.env.*"');
});

test('.gitignore ignores the root cloud.env while keeping deploy/cloud.env.example tracked', (t) => {
  const gitAvailable = spawnSync('git', ['--version']).status === 0;
  if (!gitAvailable) {
    t.skip('git is not available in this environment');
    return;
  }
  assert.equal(isIgnored('cloud.env'), true, 'the server-only cloud.env must be ignored (it holds the domain and login password)');
  assert.equal(isIgnored('cloud.env.production'), true, 'root-anchored cloud.env.* variants must be ignored');
  assert.equal(isIgnored('deploy/cloud.env.example'), false, 'deploy/cloud.env.example must remain tracked');
});
