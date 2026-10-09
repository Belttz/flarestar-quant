// 部署脚本回归测试：覆盖 deploy/server 与仓库根目录的 shell 脚本。
//
// 这些脚本跑在用户的服务器上，本地没有单元测试覆盖，所以至少固定住：
//   1. 语法（bash -n）与 --help 可用性
//   2. bootstrap.sh 的参数透传语义（这一步最容易在重构中被悄悄改坏）
//   3. 危险路径的拒绝行为（非空目录覆盖、非法 ref、克隆失败）
//   4. 升级路径不会删掉安装目录里未跟踪的 cloud.env / .local-data
//
// 缺少 bash / git / tar 的环境会自动跳过对应用例（例如纯 Windows 且未装 Git Bash）。

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BOOTSTRAP = join(REPO_ROOT, 'deploy', 'server', 'bootstrap.sh');
const BASH = process.env.GCT_BASH || 'bash';

const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响测试结论：临时目录在系统 tmp 下。
    }
  }
});

function mkTemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `gct-deploy-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

function hasCommand(command) {
  const probe = run(command, ['--version']);
  return !probe.error && probe.status === 0;
}

const hasBash = (() => {
  const probe = run(BASH, ['-c', 'printf ok']);
  return !probe.error && probe.status === 0 && probe.stdout.trim() === 'ok';
})();

const hasGit = hasCommand('git');

const skipWithoutBash = hasBash ? false : `找不到可用的 bash（设置 GCT_BASH 可指定路径）`;

const skipIfNoGit = hasGit ? false : '缺少 git';

// deploy/server 的目标平台是 Linux，脚本只接受以 / 开头的绝对路径。
// 在 Windows 上跑测试时，用 cygpath 把 node 的 Windows 路径翻译成 bash 能识别的 POSIX 路径；
// 翻译不了就跳过对应的用例（这些用例的真正主场是 Linux CI）。
function bashPath(path) {
  if (process.platform !== 'win32') return path;
  const converted = run('cygpath', ['-u', path]);
  const value = (converted.stdout || '').trim();
  if (converted.status !== 0 || !value.startsWith('/')) return null;
  return value;
}

const CANNOT_CONVERT = '无法把 Windows 路径转换为 bash 路径（缺少 cygpath），请在 Linux 上运行';

/**
 * `tar` is invoked directly (not through bash), so on Windows it resolves to the runner's native
 * bsdtar, which does not understand MSYS paths such as `/tmp/...`. Hand it a native path instead.
 * On POSIX this is a no-op.
 */
function tarPath(path) {
  return path.replaceAll('\\', '/');
}

function runBootstrap(args, options = {}) {
  const result = run(BASH, [BOOTSTRAP, ...args], options);
  // 脚本输出带 ANSI 着色，断言前先剥掉，避免颜色码干扰匹配。
  return {
    ...result,
    stdout: stripAnsi(result.stdout || ''),
    stderr: stripAnsi(result.stderr || ''),
  };
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

// 造一个「有 deploy/server/install.sh」的假项目目录，用于替换真实安装器。
function makeFakeSourceDir() {
  const root = mkTemp('src');
  mkdirSync(join(root, 'deploy', 'server'), { recursive: true });
  const stub = join(root, 'deploy', 'server', 'install.sh');
  writeFileSync(
    stub,
    ['#!/usr/bin/env bash', 'echo "STUB_COUNT=$#"', 'for arg in "$@"; do printf \'STUB_ARG|%s\\n\' "$arg"; done', ''].join('\n'),
  );
  return root;
}

function makeGitRepo() {
  const root = mkTemp('origin');
  mkdirSync(join(root, 'deploy', 'server'), { recursive: true });
  writeFileSync(join(root, 'deploy', 'server', 'install.sh'), '#!/usr/bin/env bash\necho "STUB v1 $*"\n');
  writeFileSync(join(root, 'README.md'), 'v1\n');
  const git = (...args) => run('git', ['-C', root, ...args]);
  const commit = (...args) => run('git', ['-C', root, '-c', 'user.email=test@example.com', '-c', 'user.name=test', ...args]);
  const init = git('init', '-q', '-b', 'main');
  if (init.status !== 0) return null;
  commit('add', '-A');
  commit('commit', '-qm', 'v1');
  return root;
}

describe('deploy shell scripts', () => {
  test('所有 shell 脚本通过 bash -n 语法检查', { skip: skipWithoutBash }, () => {
    const scripts = [
      join(REPO_ROOT, 'bootstrap.sh'),
      join(REPO_ROOT, 'install.sh'),
      join(REPO_ROOT, 'uninstall.sh'),
      join(REPO_ROOT, 'deploy', 'server', '_common.sh'),
      join(REPO_ROOT, 'deploy', 'server', 'install.sh'),
      join(REPO_ROOT, 'deploy', 'server', 'bootstrap.sh'),
      join(REPO_ROOT, 'deploy', 'server', 'uninstall.sh'),
      join(REPO_ROOT, 'deploy', 'server', 'update.sh'),
    ];
    for (const script of scripts) {
      assert.ok(existsSync(script), `脚本缺失：${script}`);
      const result = run(BASH, ['-n', script]);
      assert.equal(result.status, 0, `${script} 语法错误：\n${result.stderr}`);
    }
  });

  test('bootstrap.sh --help 退出码 0 并打印用法', { skip: skipWithoutBash }, () => {
    const result = runBootstrap(['--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /一条命令拉取安装/);
    assert.match(result.stdout, /--source/);
  });

  test('未知参数原样转发给 install.sh', { skip: skipWithoutBash }, () => {
    const source = makeFakeSourceDir();
    const result = runBootstrap([
      '--source', source,
      '--domain', 'quant.example.com',
      '--username', 'Belttz',
      '--password', 'p@ss word',
      '--yes',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /STUB_COUNT=7/);
    for (const arg of ['--domain', 'quant.example.com', '--username', 'Belttz', '--password', 'p@ss word', '--yes']) {
      assert.ok(result.stdout.includes(`STUB_ARG|${arg}`), `参数未透传：${arg}\n${result.stdout}`);
    }
  });

  test('-- 之后的内容整体转发给 install.sh', { skip: skipWithoutBash }, () => {
    const source = makeFakeSourceDir();
    const result = runBootstrap(['--source', source, '--', '--domain', 'a.example.com', '-y']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /STUB_COUNT=3/);
    assert.ok(result.stdout.includes('STUB_ARG|-y'));
  });

  test('--source 指向不存在的路径时报错退出', { skip: skipWithoutBash }, () => {
    const missing = join(mkTemp('missing'), 'nope');
    const result = runBootstrap(['--source', missing, '--domain', 'x.example.com']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /路径不存在/);
  });

  test('安装目录非空且不是 git 仓库时拒绝覆盖', { skip: skipWithoutBash }, (t) => {
    const occupied = mkTemp('occupied');
    writeFileSync(join(occupied, 'keep.txt'), 'keep\n');
    const bashDir = bashPath(occupied);
    if (!bashDir) return t.skip(CANNOT_CONVERT);
    const result = runBootstrap(['--dir', bashDir, '--domain', 'x.example.com']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /拒绝覆盖/);
    // 关键：不能动用户原有的文件
    assert.ok(existsSync(join(occupied, 'keep.txt')));
  });

  test('相对安装目录被拒绝', { skip: skipWithoutBash }, () => {
    const result = runBootstrap(['--dir', 'relative/dir', '--domain', 'x.example.com']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /绝对路径/);
  });

  test('非法分支名被拒绝', { skip: skipWithoutBash }, () => {
    const source = makeFakeSourceDir();
    for (const ref of ['../evil', '-flag', 'a b']) {
      const result = runBootstrap(['--source', source, '--ref', ref, '--domain', 'x.example.com']);
      assert.notEqual(result.status, 0, `ref 应被拒绝：${ref}`);
      assert.match(result.stderr, /分支\/标签名无效/);
    }
  });

  test('目标目录存在但缺少 deploy/server/install.sh 时给出明确提示', { skip: skipWithoutBash }, () => {
    const bare = mkTemp('bare');
    mkdirSync(join(bare, 'deploy'), { recursive: true });
    const result = runBootstrap(['--source', bare, '--domain', 'x.example.com']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /找不到 deploy\/server\/install\.sh/);
  });

  test('克隆失败时给出可执行的排错提示', { skip: skipWithoutBash || skipIfNoGit }, (t) => {
    const dir = join(mkTemp('clone-target'), 'install');
    const bashDir = bashPath(dir);
    const bashMissing = bashPath(join(tmpdir(), 'gct-no-such-repo'));
    if (!bashDir || !bashMissing) return t.skip(CANNOT_CONVERT);
    const result = runBootstrap(['--repo', `file://${bashMissing}`, '--dir', bashDir, '--domain', 'x.example.com']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /克隆失败/);
  });

  test('.tar.gz 源码包解压到 --dir 并就地安装', { skip: skipWithoutBash }, (t) => {
    if (!hasCommand('tar')) return t.skip('缺少 tar');
    const source = makeFakeSourceDir();
    const archive = join(mkTemp('archive'), 'src.tar.gz');
    const target = join(mkTemp('extract'), 'install');
    const bashArchive = bashPath(archive);
    const bashSource = bashPath(source);
    const bashTarget = bashPath(target);
    if (!bashArchive || !bashSource || !bashTarget) return t.skip(CANNOT_CONVERT);

    const packed = run('tar', ['-czf', tarPath(archive), '-C', tarPath(source), '.']);
    assert.equal(packed.status, 0, packed.stderr || packed.stdout);

    const result = runBootstrap(['--source', bashArchive, '--dir', bashTarget, '--domain', 'b.example.com']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('STUB_ARG|b.example.com'));
    // 解压结果必须留在 --dir 里：install.sh 之后还要靠同目录的 cloud.env / compose 文件运维
    assert.ok(existsSync(join(target, 'deploy', 'server', 'install.sh')), '源码包应解压到持久安装目录');
  });

  test('源码包不会覆盖非空的安装目录', { skip: skipWithoutBash }, (t) => {
    if (!hasCommand('tar')) return t.skip('缺少 tar');
    const source = makeFakeSourceDir();
    const archive = join(mkTemp('archive-occupied'), 'src.tar.gz');
    const target = mkTemp('extract-occupied');
    const bashArchive = bashPath(archive);
    const bashSource = bashPath(source);
    const bashTarget = bashPath(target);
    if (!bashArchive || !bashSource || !bashTarget) return t.skip(CANNOT_CONVERT);

    assert.equal(run('tar', ['-czf', tarPath(archive), '-C', tarPath(source), '.']).status, 0);
    writeFileSync(join(target, 'cloud.env'), 'GCT_DOMAIN=existing.example.com\n');

    const result = runBootstrap(['--source', bashArchive, '--dir', bashTarget, '--domain', 'b.example.com']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /拒绝把源码包解压进去/);
    assert.equal(readFileSync(join(target, 'cloud.env'), 'utf8'), 'GCT_DOMAIN=existing.example.com\n');
  });
});

describe('deploy/server/bootstrap.sh 克隆与升级', { skip: skipWithoutBash || skipIfNoGit }, () => {
  test('首次克隆后重复执行会更新到最新提交，且保留未跟踪文件', (t) => {
    const origin = makeGitRepo();
    assert.ok(origin, '本地 git 仓库初始化失败');

    const installDir = join(mkTemp('clone'), 'install');
    const bashOrigin = bashPath(origin);
    const bashInstallDir = bashPath(installDir);
    if (!bashOrigin || !bashInstallDir) return t.skip(CANNOT_CONVERT);
    const cloneUrl = `file://${bashOrigin}`;
    const first = runBootstrap(['--repo', cloneUrl, '--dir', bashInstallDir, '--domain', 'a.example.com']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /STUB v1/);

    // 模拟真实使用后的本地状态：cloud.env 与数据库都不在版本控制里
    writeFileSync(join(installDir, 'cloud.env'), 'GCT_DOMAIN=a.example.com\n');
    mkdirSync(join(installDir, '.local-data'), { recursive: true });
    writeFileSync(join(installDir, '.local-data', 'gate-crossex.sqlite'), 'db\n');

    // 上游产生一个新提交
    writeFileSync(join(origin, 'deploy', 'server', 'install.sh'), '#!/usr/bin/env bash\necho "STUB v2 $*"\n');
    writeFileSync(join(origin, 'README.md'), 'v1\nv2\n');
    const commit = (...args) =>
      run('git', ['-C', origin, '-c', 'user.email=test@example.com', '-c', 'user.name=test', ...args]);
    commit('add', '-A');
    commit('commit', '-qm', 'v2');

    const second = runBootstrap(['--repo', cloneUrl, '--dir', bashInstallDir, '--domain', 'a.example.com']);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /STUB v2/, '升级后应执行新版 install.sh');

    assert.equal(readFileSync(join(installDir, 'cloud.env'), 'utf8'), 'GCT_DOMAIN=a.example.com\n');
    assert.equal(readFileSync(join(installDir, '.local-data', 'gate-crossex.sqlite'), 'utf8'), 'db\n');
  });
});;
