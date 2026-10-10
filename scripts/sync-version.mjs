#!/usr/bin/env node
/**
 * Keep every workspace manifest — and the root lockfile — pinned to the version
 * declared in the root `package.json`.
 *
 * The root manifest's `version` is the single source of truth:
 *   - `apps/*` and `packages/*` receive that exact version;
 *   - every `@gate-crossex/*` dependency range inside those manifests is rewritten
 *     to match it (workspace packages are linked by exact version, so a stale range
 *     breaks `npm ci` and trips the release-bundle guard in
 *     `scripts/build-release-bundle.mjs`);
 *   - `package-lock.json`'s root and workspace entries are updated so `npm ci`
 *     (used verbatim by the Dockerfile) stays in sync without re-resolving the tree.
 *
 * Usage:
 *   node scripts/sync-version.mjs           # rewrite every manifest + the lockfile
 *   node scripts/sync-version.mjs --check    # report drift, write nothing, exit 1 on drift
 *
 * The operation is idempotent: a second run reports "already synced". Structural
 * problems (a workspace pattern matching nothing, a missing lockfile entry, a root
 * version that is not semver) fail loudly instead of being skipped silently.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Root of the repository (this file lives in `scripts/`). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every dependency section that may reference a `@gate-crossex/*` workspace package. */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const SCOPED_PREFIX = '@gate-crossex/';
const ROOT_MANIFEST = 'package.json';
const LOCKFILE = 'package-lock.json';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Reproduce the original file's shape so version bumps produce minimal diffs:
 * single-line manifests stay single-line, indented ones keep two-space indentation,
 * and a trailing newline is preserved only when the source had one.
 *
 * @param {unknown} value Parsed JSON value to serialise.
 * @param {string} previousText Raw text the value was parsed from.
 * @returns {string} Serialised JSON matching the previous layout.
 */
function serializeLike(value, previousText) {
  const endsWithNewline = previousText.endsWith('\n');
  // A file that is a single line plus an optional trailing newline must not be
  // expanded into pretty-printed JSON; only genuine multi-line bodies keep indent.
  const wasMultiline = previousText.replace(/\r?\n$/, '').includes('\n');
  const body = wasMultiline ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  return `${body}${endsWithNewline ? '\n' : ''}`;
}

/**
 * Expand the root `workspaces` globs into concrete package directories.
 *
 * Only the `<dir>/*` shape used by this repository is supported; anything else is
 * reported as an error rather than guessed at. A pattern that resolves to zero
 * packages is a structural error (it means a workspace silently disappeared).
 *
 * @param {string} rootDir Repository root.
 * @param {string[]} patterns Raw `workspaces` patterns from the root manifest.
 * @param {string[]} errors Collector mutated with human-readable problems.
 * @returns {string[]} POSIX-style relative directory names containing a `package.json`.
 */
export function expandWorkspaces(rootDir, patterns, errors) {
  const directories = [];
  for (const rawPattern of patterns) {
    const pattern = String(rawPattern).replace(/\/+$/, '');
    const starIndex = pattern.indexOf('*');
    if (starIndex === -1) {
      if (!existsSync(join(rootDir, pattern, 'package.json'))) {
        errors.push(`workspace "${pattern}" has no package.json`);
        continue;
      }
      directories.push(pattern.split(/[\\/]/).join('/'));
      continue;
    }
    if (pattern.indexOf('*', starIndex + 1) !== -1) {
      errors.push(`workspace pattern "${rawPattern}" uses more than one "*", which is not supported`);
      continue;
    }
    const base = pattern.slice(0, starIndex).replace(/\/+$/, '');
    const suffix = pattern.slice(starIndex + 1);
    const baseDir = join(rootDir, base);
    if (!existsSync(baseDir) || !statSync(baseDir).isDirectory()) {
      errors.push(`workspace pattern "${rawPattern}" points at a missing directory "${base}"`);
      continue;
    }
    const matches = readdirSync(baseDir)
      .filter((entry) => statSync(join(baseDir, entry)).isDirectory())
      .filter((entry) => existsSync(join(baseDir, entry, suffix, 'package.json')))
      .sort();
    if (matches.length === 0) {
      errors.push(`workspace pattern "${rawPattern}" matched no packages`);
      continue;
    }
    for (const entry of matches) directories.push(join(base, entry, suffix).split(/[\\/]/).join('/'));
  }
  return directories;
}

/**
 * Compute — without writing anything — every change required to pin the tree to
 * the root version.
 *
 * @param {string} rootDir Repository root to inspect.
 * @returns {{
 *   version: string,
 *   changes: Array<{ file: string, description: string, from: unknown, to: unknown }>,
 *   errors: string[],
 *   writes: Array<{ path: string, text: string }>,
 * }} A plan describing drift, structural errors, and the file contents to write.
 */
export function planSync(rootDir = ROOT) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Array<{ file: string, description: string, from: unknown, to: unknown }>} */
  const changes = [];
  /** @type {Array<{ path: string, text: string }>} */
  const writes = [];

  const rootManifestPath = join(rootDir, ROOT_MANIFEST);
  const rootText = readFileSync(rootManifestPath, 'utf8');
  const rootManifest = JSON.parse(rootText);
  const version = rootManifest.version;
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    errors.push(`root ${ROOT_MANIFEST} version ${JSON.stringify(version)} is not a valid semver`);
  }
  const patterns = Array.isArray(rootManifest.workspaces) ? rootManifest.workspaces : [];
  if (patterns.length === 0) errors.push(`root ${ROOT_MANIFEST} declares no "workspaces"`);
  const workspaceDirectories = expandWorkspaces(rootDir, patterns, errors);

  /**
   * Record a single field that drifted from the expected version.
   *
   * @param {Record<string, unknown>} target Parsed JSON object to mutate in memory.
   * @param {string} key Property name to compare and overwrite.
   * @param {string} file Relative file name used in the drift report.
   * @param {string} description Human-readable field path.
   * @returns {boolean} Whether the field drifted.
   */
  const applyIfDifferent = (target, key, file, description) => {
    if (target[key] === version) return false;
    changes.push({ file, description, from: target[key], to: version });
    target[key] = version;
    return true;
  };

  for (const directory of workspaceDirectories) {
    const file = `${directory}/package.json`;
    const path = join(rootDir, file);
    const text = readFileSync(path, 'utf8');
    const manifest = JSON.parse(text);
    let dirty = applyIfDifferent(manifest, 'version', file, 'version');
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = manifest[field];
      if (!dependencies || typeof dependencies !== 'object') continue;
      for (const name of Object.keys(dependencies)) {
        if (!name.startsWith(SCOPED_PREFIX)) continue;
        dirty = applyIfDifferent(dependencies, name, file, `${field}.${name}`) || dirty;
      }
    }
    if (dirty) writes.push({ path, text: serializeLike(manifest, text) });
  }

  const lockPath = join(rootDir, LOCKFILE);
  if (!existsSync(lockPath)) {
    errors.push(`${LOCKFILE} is missing; run \`npm install\` to regenerate it`);
  } else {
    const lockText = readFileSync(lockPath, 'utf8');
    const lock = JSON.parse(lockText);
    const packages = lock.packages ?? {};
    let lockDirty = applyIfDifferent(lock, 'version', LOCKFILE, 'version');
    if (!packages[''] || typeof packages[''] !== 'object') {
      errors.push(`${LOCKFILE} is missing its root ("" ) entry`);
    } else {
      lockDirty = applyIfDifferent(packages[''], 'version', LOCKFILE, 'packages[""].version') || lockDirty;
    }
    for (const directory of workspaceDirectories) {
      const entry = packages[directory];
      if (!entry || typeof entry !== 'object') {
        errors.push(`${LOCKFILE} is missing the "${directory}" workspace entry; run \`npm install\` to regenerate it`);
        continue;
      }
      lockDirty = applyIfDifferent(entry, 'version', LOCKFILE, `${directory}.version`) || lockDirty;
      for (const field of DEPENDENCY_FIELDS) {
        const dependencies = entry[field];
        if (!dependencies || typeof dependencies !== 'object') continue;
        for (const name of Object.keys(dependencies)) {
          if (!name.startsWith(SCOPED_PREFIX)) continue;
          lockDirty = applyIfDifferent(dependencies, name, LOCKFILE, `${directory}.${field}.${name}`) || lockDirty;
        }
      }
    }
    if (lockDirty) writes.push({ path: lockPath, text: serializeLike(lock, lockText) });
  }

  return { version, changes, errors, writes };
}

/**
 * CLI entry point: apply or check the sync plan.
 *
 * @returns {void}
 */
function main() {
  const checkOnly = process.argv.includes('--check');
  const plan = planSync(ROOT);

  if (plan.errors.length > 0) {
    console.error('sync-version: the repository structure is inconsistent:');
    for (const error of plan.errors) console.error(`  - ${error}`);
    process.exit(2);
  }

  if (plan.changes.length === 0) {
    console.log(`sync-version: ${plan.version} — every workspace and the lockfile already match.`);
    return;
  }

  if (checkOnly) {
    console.error(`sync-version: version drift detected (root is ${plan.version}):`);
    for (const change of plan.changes) {
      console.error(`  - ${change.file}: ${change.description} is ${JSON.stringify(change.from)}, expected ${JSON.stringify(change.to)}`);
    }
    console.error('Run `npm run version:sync` to fix it.');
    process.exit(1);
  }

  for (const write of plan.writes) writeFileSync(write.path, write.text);
  console.log(`sync-version: updated ${plan.changes.length} field(s) across ${plan.writes.length} file(s) to ${plan.version}:`);
  for (const change of plan.changes) {
    console.log(`  - ${change.file}: ${change.description} ${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}`);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) main();
