#!/usr/bin/env node
/**
 * One-command release helper for the Linux server upgrade path.
 *
 * It performs, in order: version-consistency check → production build → `git archive`
 * source bundle → prints the exact follow-up commands. It deliberately NEVER commits,
 * tags, or pushes — that stays a deliberate human step.
 *
 * Server upgrades run through the git/tag path (the host is already a `git clone`), so
 * the artifact produced here is the reproducible source bundle whose absence used to
 * force hand-made archives. That bundle is *not* what `deploy/server/bootstrap.sh`
 * consumes for an upgrade (that uses `fetch + reset --hard`); it exists so the tree can
 * be reproduced and archived from a clean HEAD.
 *
 * Usage:
 *   node scripts/release-server.mjs                # refuse to package a dirty worktree
 *   node scripts/release-server.mjs --allow-dirty   # explicit opt-in; the bundle then
 *                                                   # contains HEAD only, NOT your edits
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSync } from './sync-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowDirty = process.argv.includes('--allow-dirty');

/**
 * Abort the release with a prominent message.
 *
 * @param {string} message Human-readable reason.
 * @returns {never}
 */
function fail(message) {
  console.error(`\nrelease-server: ${message}\n`);
  process.exit(1);
}

/**
 * Run a command, inheriting stdio, aborting the release on failure.
 *
 * @param {string} command Executable to run.
 * @param {string[]} args Argument list.
 * @param {import('node:child_process').SpawnSyncOptions} [options] Extra spawn options.
 * @returns {void}
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail(`\`${command} ${args.join(' ')}\` failed with exit code ${result.status}`);
}

/**
 * Run a command and capture trimmed stdout, aborting on failure.
 *
 * @param {string} command Executable to run.
 * @param {string[]} args Argument list.
 * @returns {string} Trimmed stdout.
 */
function output(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail(`\`${command} ${args.join(' ')}\` failed: ${(result.stderr ?? '').trim()}`);
  return result.stdout.trim();
}

/**
 * Run an npm sub-command using the npm that launched this script when available.
 *
 * @param {string[]} args npm arguments, e.g. `['run', 'build']`.
 * @returns {void}
 */
function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && existsSync(npmCli)) {
    run(process.execPath, [npmCli, ...args], { cwd: root });
    return;
  }
  run('npm', args, { cwd: root, shell: process.platform === 'win32' });
}

// 1. Version consistency — refuse to build a tree whose manifests disagree with the root.
const plan = planSync(root);
if (plan.errors.length > 0) {
  console.error('release-server: the repository structure is inconsistent:');
  for (const error of plan.errors) console.error(`  - ${error}`);
  fail('fix the structure above (run `npm run version:sync`)');
}
if (plan.changes.length > 0) {
  console.error(`release-server: version drift detected (root is ${plan.version}):`);
  for (const change of plan.changes) {
    console.error(`  - ${change.file}: ${change.description} is ${JSON.stringify(change.from)}, expected ${JSON.stringify(change.to)}`);
  }
  fail('run `npm run version:sync` and commit the result before releasing');
}
const version = plan.version;
console.log(`release-server: version ${version} — manifests and lockfile are consistent.`);

// 2. Dirty-worktree guard: a `git archive` bundle only ever reflects committed HEAD.
const dirty = output('git', ['-C', root, 'status', '--short']);
if (dirty && !allowDirty) {
  console.error('release-server: the worktree has uncommitted changes:');
  console.error(dirty.split('\n').map((line) => `  ${line}`).join('\n'));
  fail('源码包只能反映已提交的 HEAD，请先提交（或加 --allow-dirty 显式放行）');
}
if (dirty && allowDirty) {
  console.warn('\n  !! --allow-dirty：源码包只包含已提交的 HEAD，**不包含**下列未提交改动：');
  console.warn(dirty.split('\n').map((line) => `    ${line}`).join('\n'));
  console.warn('');
}

// 3. Production build (packages -> backend -> frontend).
console.log(`release-server: building (npm run build)...`);
runNpm(['run', 'build']);

// 4. Reproducible source bundle from HEAD, with a top-level directory matching the
//    existing artifact shape (`flarestar-quant-<version>/`).
const outputDirectory = join(root, 'deliverables', 'dist');
mkdirSync(outputDirectory, { recursive: true });
const assetName = `flarestar-quant-${version}-src.tar.gz`;
const outputPath = join(outputDirectory, assetName);
const prefix = `flarestar-quant-${version}/`;
const commit = output('git', ['-C', root, 'rev-parse', 'HEAD']);

console.log(`release-server: archiving HEAD (${commit.slice(0, 12)}) -> ${assetName}...`);
run('git', ['-C', root, 'archive', '--format=tar.gz', `--prefix=${prefix}`, '-o', outputPath, 'HEAD']);

const listing = spawnSync('tar', ['-tzf', outputPath], { encoding: 'utf8' });
if (!listing.error && listing.status === 0) {
  const firstEntry = listing.stdout.split('\n')[0];
  if (firstEntry && !firstEntry.startsWith(prefix)) {
    fail(`archive top-level entry is "${firstEntry}", expected it to start with "${prefix}"`);
  }
} else if (listing.error) {
  console.warn(`release-server: could not verify archive contents automatically (${listing.error.message}).`);
}

const digest = createHash('sha256').update(readFileSync(outputPath)).digest('hex');
const sizeMiB = (statSync(outputPath).size / 1024 / 1024).toFixed(2);
console.log(`release-server: created ${outputPath} (${sizeMiB} MiB)`);
console.log(`release-server: SHA-256 ${digest}`);

// 5. Follow-up steps. Never executed here on purpose.
const serverCommand = 'curl -fsSL https://raw.githubusercontent.com/Belttz/flarestar-quant/main/deploy/server/bootstrap.sh | sudo bash -s -- --yes';
console.log(`
──────────────────────────────────────────────────────────────────────────
下一步（本脚本不会自动 commit / tag / push）：

1) 提交本轮改动后，打标签并推送（tag 必须形如 v${version}）：

     git tag v${version} && git push origin main --tags

2) 在服务器上一条命令更新到该版本：

     ${serverCommand}

   安装目录非默认（非 /opt/gate-crossex）时补 \`--dir <路径>\`。
   升级走 git：\`fetch --depth 1\` + \`reset --hard FETCH_HEAD\`，
   未跟踪的 cloud.env（域名 + 登录口令）与 .local-data/ 数据卷会被原样保留。

3) 不要手工编辑服务器上的 deploy/Caddyfile —— 重新部署会自动恢复它；
   确需保留本地改动时设逃生舱 GCT_KEEP_DEPLOY_CONFIG=1。
──────────────────────────────────────────────────────────────────────────`);
