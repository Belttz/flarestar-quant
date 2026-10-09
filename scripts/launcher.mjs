import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { arch, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { needsBuild } from './build-fresh.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.GCT_DATA_DIR ?? join(root, '.local-data'));
const logsDir = join(root, 'logs');
const configPath = join(dataDir, 'config.json');
const runtimePath = join(dataDir, 'runtime.json');
const isWindows = process.platform === 'win32';
const npmCliCandidates = [
  process.env.npm_execpath,
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].filter(Boolean);
const npmCli = isWindows ? npmCliCandidates.find(existsSync) : null;
const npmCommand = npmCli ? process.execPath : isWindows ? 'npm.cmd' : 'npm';

function npmArgs(args) {
  return npmCli ? [npmCli, ...args] : args;
}

/**
 * Independent build stages behind the launcher's startup sequence. Each stage builds only when
 * its outputs are stale relative to its own sources plus its config/manifest inputs; the shared
 * packages' dist artifacts are counted among the downstream stages' inputs, so rebuilding a
 * package cascades into the backend and frontend builds. GCT_FORCE_BUILD=1 bypasses the checks.
 */
function buildStages(mode) {
  const packageSources = ['shared-types', 'domain', 'public-data']
    .map((name) => join(root, 'packages', name, 'src'));
  const packageExtraFiles = ['shared-types', 'domain', 'public-data']
    .flatMap((name) => [
      join(root, 'packages', name, 'package.json'),
      join(root, 'packages', name, 'tsconfig.json'),
    ]);
  const packageOutputs = ['shared-types', 'domain', 'public-data']
    .map((name) => join(root, 'packages', name, 'dist', 'index.js'));
  const packageStage = {
    name: 'shared packages',
    command: ['run', 'build:packages'],
    sources: packageSources,
    extraFiles: packageExtraFiles,
    outputs: packageOutputs,
  };
  if (mode === 'dev') return [packageStage];
  return [
    packageStage,
    {
      name: 'backend',
      command: ['run', 'build', '-w', 'apps/backend'],
      sources: [join(root, 'apps', 'backend', 'src')],
      extraFiles: [
        join(root, 'apps', 'backend', 'package.json'),
        join(root, 'apps', 'backend', 'tsconfig.json'),
        ...packageOutputs,
      ],
      outputs: [join(root, 'apps', 'backend', 'dist', 'server.js')],
    },
    {
      name: 'frontend',
      command: ['run', 'build', '-w', 'apps/frontend'],
      sources: [join(root, 'apps', 'frontend', 'src'), join(root, 'apps', 'frontend', 'index.html')],
      extraFiles: [
        join(root, 'apps', 'frontend', 'package.json'),
        join(root, 'apps', 'frontend', 'tsconfig.json'),
        join(root, 'apps', 'frontend', 'tsconfig.app.json'),
        join(root, 'apps', 'frontend', 'tsconfig.node.json'),
        join(root, 'apps', 'frontend', 'vite.config.ts'),
        ...packageOutputs,
      ],
      outputs: [join(root, 'apps', 'frontend', 'dist', 'index.html')],
    },
  ];
}

function spawnNpmSync(args, options) {
  return spawnSync(npmCommand, npmArgs(args), options);
}

function spawnNpm(args, options) {
  return spawn(npmCommand, npmArgs(args), options);
}

process.umask?.(0o077);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
mkdirSync(logsDir, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') {
  chmodSync(dataDir, 0o700);
  chmodSync(logsDir, 0o700);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (!isWindows) chmodSync(path, 0o600);
}

function removeExitedBackendLock(pid) {
  if (!Number.isInteger(pid) || processExists(pid)) return;
  const lockPath = join(dataDir, 'backend.lock');
  const lock = readJson(lockPath);
  if (lock?.pid === pid) rmSync(lockPath, { force: true });
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Children are spawned as detached process-group leaders, so the group id stays killable even
 * after npm (the leader) or the launcher itself has died — the tsx/vite grandchildren that used
 * to be orphaned are members of the same group.
 */
function groupExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(isWindows ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recordedProcessAlive(pid) {
  return groupExists(pid) || processExists(pid);
}

function signalTree(pid, signal) {
  if (!Number.isInteger(pid) || pid < 1) return;
  if (isWindows) {
    const args = ['/pid', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])];
    spawnSync('taskkill', args, { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

/** Never signal a recycled pid that now belongs to an unrelated process. */
function safeToSignalGroup(pid) {
  if (isWindows) return processExists(pid);
  if (!groupExists(pid)) return false;
  // Leader dead but the group lives on: surviving members inherited our group id — ours.
  if (!processExists(pid)) return true;
  const commandLine = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '';
  return /node|npm|tsx|vite/i.test(commandLine);
}

function sleep(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForGroupsGone(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !recordedProcessAlive(pid))) return true;
    await sleep(150);
  }
  return pids.every((pid) => !recordedProcessAlive(pid));
}

/** SIGTERM the child process groups, escalate to SIGKILL, and report whether all are gone. */
async function terminateProcessGroups(pids) {
  const targets = pids.filter((pid) => Number.isInteger(pid) && recordedProcessAlive(pid));
  for (const pid of targets) signalTree(pid, 'SIGTERM');
  // The backend may spend up to 20 seconds proving strategy-order cancellations. Preserve that
  // safety window before escalating an otherwise stuck process to SIGKILL.
  if (await waitForGroupsGone(targets, 25_000)) return true;
  for (const pid of targets) {
    if (recordedProcessAlive(pid)) signalTree(pid, 'SIGKILL');
  }
  return waitForGroupsGone(targets, 3_000);
}

async function freePort(preferredPort) {
  for (let port = preferredPort; port < preferredPort + 100; port += 1) {
    const available = await new Promise((resolveAvailability, rejectAvailability) => {
      const server = createServer();
      server.once('error', (error) => {
        if (error.code === 'EADDRINUSE') resolveAvailability(false);
        else rejectAvailability(error);
      });
      server.listen({ host: '127.0.0.1', port }, () => {
        server.close(() => resolveAvailability(true));
      });
    });
    if (available) return port;
  }
  throw new Error(`No available local port found near ${preferredPort}`);
}

function pipeProcessOutput(child, label, logName) {
  const logPath = join(logsDir, logName);
  rotateLog(logPath);
  const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  log.once('open', () => {
    if (!isWindows) chmodSync(logPath, 0o600);
  });
  const forward = (target) => (chunk) => {
    log.write(chunk);
    target.write(`[${label}] ${chunk}`);
  };
  child.stdout?.on('data', forward(process.stdout));
  child.stderr?.on('data', forward(process.stderr));
  child.once('close', () => log.end());
}

function rotateLog(path, maximumBytes = 5 * 1024 * 1024, retainedFiles = 3) {
  if (!existsSync(path) || statSync(path).size < maximumBytes) return;
  for (let index = retainedFiles; index >= 1; index -= 1) {
    const source = index === 1 ? path : `${path}.${index - 1}`;
    const destination = `${path}.${index}`;
    if (!existsSync(source)) continue;
    rmSync(destination, { force: true });
    renameSync(source, destination);
  }
}

async function waitForUrl(url, childProcesses, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (childProcesses.some((child) => child.exitCode !== null)) {
      throw new Error(`A local service exited before ${url} became healthy`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The services are still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function openBrowser(url) {
  if (process.env.GCT_NO_OPEN === '1') return;
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const opener = spawn(command, args, { detached: true, stdio: 'ignore' });
  opener.once('error', () => {
    console.warn(`Could not open a browser automatically. Open ${url} manually.`);
  });
  opener.unref();
}

async function start(mode) {
  const previousRuntime = readJson(runtimePath);
  if (previousRuntime) {
    // A dead launcher does not mean a dead stack: surviving backend/frontend groups (or a live
    // backend on the recorded port) would mean two strategy engines sharing one database.
    const recordedPids = [previousRuntime.launcherPid, previousRuntime.backendPid, previousRuntime.frontendPid];
    let alive = recordedPids.some(recordedProcessAlive);
    if (!alive && Number.isInteger(previousRuntime.backendPort)) {
      try {
        const response = await fetch(`http://127.0.0.1:${previousRuntime.backendPort}/health`, { signal: AbortSignal.timeout(700) });
        alive = response.ok;
      } catch {
        // Nothing is serving the recorded port; the previous stack is really gone.
      }
    }
    if (alive) {
      console.error(`Gate CrossEx (or part of it) is already running at http://127.0.0.1:${previousRuntime.frontendPort}. Run ./run stop first.`);
      process.exitCode = 1;
      return;
    }
    rmSync(runtimePath, { force: true });
  }

  const configured = readJson(configPath);
  const requestedBackendPort = Number(process.env.GCT_PORT ?? configured?.ports?.backend ?? 17840);
  const requestedFrontendPort = Number(process.env.GCT_FRONTEND_PORT ?? configured?.ports?.frontend ?? 5173);
  const backendPort = await freePort(requestedBackendPort);
  const frontendPort = mode === 'dev'
    ? await freePort(requestedFrontendPort === backendPort ? requestedFrontendPort + 1 : requestedFrontendPort)
    : backendPort;

  // Trading mode is chosen in the web app after the disclaimer; the backend always boots locked.
  writeJson(configPath, {
    schemaVersion: 1,
    mode: 'live',
    host: '127.0.0.1',
    ports: { backend: backendPort, frontend: frontendPort },
  });

  const forceBuild = process.env.GCT_FORCE_BUILD === '1';
  for (const stage of buildStages(mode)) {
    if (!needsBuild(stage.outputs, stage.sources, stage.extraFiles, forceBuild)) {
      console.log(`[launcher] ${stage.name} are up to date, skipping their build.`);
      continue;
    }
    const stageBuild = spawnNpmSync(stage.command, { cwd: root, stdio: 'inherit' });
    if (stageBuild.error) {
      throw new Error(`Could not launch npm for the ${stage.name} build: ${stageBuild.error.message}`);
    }
    if (stageBuild.status !== 0) {
      throw new Error(`Failed to build the ${stage.name} (npm exited with code ${stageBuild.status ?? 'unknown'})`);
    }
  }

  const environment = {
    ...process.env,
    npm_package_version: readJson(join(root, 'package.json'))?.version ?? process.env.npm_package_version,
    GCT_DATA_DIR: dataDir,
    GCT_MIGRATIONS_DIR: join(root, 'migrations'),
    GCT_PORT: String(backendPort),
    GCT_FRONTEND_PORT: String(frontendPort),
    GCT_FRONTEND_ORIGIN: `http://127.0.0.1:${frontendPort}`,
    GCT_FRONTEND_DIST_DIR: join(root, 'apps/frontend/dist'),
  };
  const backendOptions = {
    cwd: root,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWindows,
  };
  // Production runs the compiled backend directly so runtime.json records the process that owns
  // the database lock. On Windows, waiting only for an npm.cmd wrapper can report a clean stop
  // while its node.exe child is still completing order-safe shutdown.
  const backend = mode === 'dev'
    ? spawnNpm(['run', 'dev', '-w', 'apps/backend'], backendOptions)
    : spawn(process.execPath, [join(root, 'apps', 'backend', 'dist', 'server.js')], backendOptions);
  const frontend = mode === 'dev'
    ? spawnNpm(['run', 'dev', '-w', 'apps/frontend'], {
        cwd: root,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !isWindows,
      })
    : null;
  const children = frontend ? [backend, frontend] : [backend];
  pipeProcessOutput(backend, 'backend', 'backend.log');
  if (frontend) pipeProcessOutput(frontend, 'frontend', 'frontend.log');

  writeJson(runtimePath, {
    schemaVersion: 1,
    launcherPid: process.pid,
    backendPid: backend.pid,
    frontendPid: frontend?.pid ?? null,
    backendPort,
    frontendPort,
    startedAt: new Date().toISOString(),
  });

  let shutdownPromise = null;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      const clean = await terminateProcessGroups(children.map((child) => child.pid));
      // Only report a clean stop when the groups are verifiably gone; a kept runtime.json lets
      // ./run stop find and finish off survivors instead of lying about the state.
      if (clean) {
        removeExitedBackendLock(backend.pid);
        rmSync(runtimePath, { force: true });
      }
      else console.error('Some local processes did not exit; kept runtime.json — run ./run stop.');
      return clean;
    })();
    return shutdownPromise;
  };
  const handleSignal = () => {
    void shutdown().then((clean) => process.exit(clean ? process.exitCode ?? 0 : 1));
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  process.once('SIGHUP', handleSignal);
  process.once('exit', () => {
    if (shutdownPromise) return;
    for (const child of children) {
      if (child.exitCode === null) signalTree(child.pid, 'SIGTERM');
    }
  });

  try {
    await Promise.all([
      waitForUrl(`http://127.0.0.1:${backendPort}/health`, children),
      waitForUrl(`http://127.0.0.1:${frontendPort}`, children),
    ]);
    console.log(`\nGate CrossEx is ready: http://127.0.0.1:${frontendPort}`);
    console.log(`Backend health: http://127.0.0.1:${backendPort}/health`);
    console.log('Press Ctrl+C to stop.');
    openBrowser(`http://127.0.0.1:${frontendPort}`);
  } catch (error) {
    await shutdown();
    throw error;
  }

  await new Promise((resolveExit) => {
    for (const child of children) {
      child.once('exit', (code, signal) => {
        if (!shutdownPromise) {
          console.error(`${child === backend ? 'Backend' : 'Frontend'} exited unexpectedly (${signal ?? code}).`);
          process.exitCode = code || 1;
        }
        resolveExit();
      });
    }
  });
  await shutdown();
}

async function stop() {
  const runtime = readJson(runtimePath);
  if (!runtime) {
    console.log('Gate CrossEx is not running.');
    return;
  }

  // A live launcher shuts its own children down (and verifies) on SIGTERM.
  if (processExists(runtime.launcherPid)) {
    process.kill(runtime.launcherPid, 'SIGTERM');
    await waitForGroupsGone([runtime.launcherPid], 30_000);
  }

  // Trust nothing until verified: the launcher may have died mid-shutdown, or long ago, leaving
  // tsx/vite grandchildren holding the ports. The recorded pids are process-group ids, so they
  // stay killable; skip any pid that now belongs to an unrelated process.
  const recordedGroups = [runtime.backendPid, runtime.frontendPid].filter((pid) => Number.isInteger(pid));
  const targets = recordedGroups.filter(recordedProcessAlive).filter((pid) => {
    if (safeToSignalGroup(pid)) return true;
    console.warn(`Recorded pid ${pid} now belongs to an unrelated process; leaving it alone.`);
    return false;
  });
  if (targets.length > 0 && !(await terminateProcessGroups(targets))) {
    const survivors = targets.filter(recordedProcessAlive);
    console.error(`Could not stop recorded local processes (pids: ${survivors.join(', ')}); kept runtime.json.`);
    process.exitCode = 1;
    return;
  }
  removeExitedBackendLock(runtime.backendPid);
  rmSync(runtimePath, { force: true });
  console.log('Stopped Gate CrossEx local services.');
}

function fileSummary(path) {
  if (!existsSync(path)) return 'missing';
  const bytes = statSync(path).size;
  return `${bytes} bytes`;
}

async function doctor() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeCompatible = (major === 20 && minor >= 19) || (major === 22 && minor >= 13) || major === 24;
  const dependenciesInstalled = existsSync(join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx'));
  const runtime = readJson(runtimePath);
  const runtimeAlive = runtime !== null && [runtime.launcherPid, runtime.backendPid, runtime.frontendPid]
    .filter((pid) => Number.isInteger(pid)).some(recordedProcessAlive);
  let health = 'not running';
  if (runtimeAlive) {
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.backendPort}/health`, { signal: AbortSignal.timeout(1_000) });
      health = response.ok ? 'healthy' : `HTTP ${response.status}`;
    } catch {
      health = 'unreachable';
    }
  }

  console.log(`node=${process.version} compatible=${nodeCompatible ? 'yes' : 'no'}`);
  const npmVersion = spawnNpmSync(['--version'], { encoding: 'utf8' });
  console.log(`npm=${npmVersion.error ? `missing (${npmVersion.error.message})` : npmVersion.stdout?.trim() || 'missing'}`);
  console.log(`os=${platform()} arch=${arch()}`);
  console.log(`dependencies=${dependenciesInstalled ? 'installed' : 'missing'}`);
  console.log(`data_dir=${dataDir}`);
  console.log(`config=${fileSummary(configPath)}`);
  console.log(`database=${fileSummary(join(dataDir, 'gate-crossex.sqlite'))}`);
  console.log(`runtime=${runtimeAlive ? 'running' : 'stopped'}`);
  console.log(`backend_health=${health}`);

  if (!nodeCompatible || !dependenciesInstalled) process.exitCode = 1;
}

function printLogTail(path, lines = 200) {
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  const maximumReadBytes = 512 * 1024;
  const readBytes = Math.min(size, maximumReadBytes);
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.alloc(readBytes);
  try {
    readSync(descriptor, buffer, 0, readBytes, size - readBytes);
  } finally {
    closeSync(descriptor);
  }
  let content = buffer.toString('utf8').split(/\r?\n/);
  if (size > readBytes) content = content.slice(1);
  console.log(`\n==> ${path} <==`);
  console.log(content.slice(-lines).join('\n'));
}

async function logs() {
  const paths = [join(logsDir, 'backend.log'), join(logsDir, 'frontend.log')];
  for (const path of paths) printLogTail(path);
  if (!paths.some(existsSync)) console.log('No log files yet.');
}

const command = process.argv[2] ?? 'start';
try {
  if (command === 'start' || command === 'dev') await start(command);
  else if (command === 'stop') await stop();
  else if (command === 'doctor') await doctor();
  else if (command === 'logs') await logs();
  else {
    console.error('Usage: launcher.mjs [start|dev|stop|doctor|logs]');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
