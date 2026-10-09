import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Clock-skew allowance: a build that finished within one second of the newest source edit is
 * still considered fresh, because filesystem timestamp granularity can invert the true order.
 */
const MTIME_SLACK_MS = 1_000;

function newestMtimeUnder(path, newest) {
  const stats = statSync(path);
  if (stats.isFile()) return stats.mtimeMs > newest ? stats.mtimeMs : newest;
  if (!stats.isDirectory()) return newest;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    // Symlinks are skipped so a stray link can never pull outside timestamps into the check.
    if (entry.isSymbolicLink()) continue;
    newest = newestMtimeUnder(join(path, entry.name), newest);
  }
  return newest;
}

/**
 * Incremental-build freshness check. Returns true only when every output file exists and the
 * oldest output is at least as new as the newest input — source files found by recursively
 * walking `sourceDirs`, plus the individual files in `extraFiles` (package manifests, configs,
 * or upstream build artifacts whose change must cascade into this stage). Missing inputs are
 * ignored, so an empty or absent source set leaves the decision to the outputs alone.
 */
export function buildIsFresh(outputs, sourceDirs, extraFiles = []) {
  if (!outputs.every((output) => existsSync(output))) return false;
  let newestSource = 0;
  for (const dir of sourceDirs) {
    if (!existsSync(dir)) continue;
    newestSource = newestMtimeUnder(dir, newestSource);
  }
  for (const file of extraFiles) {
    if (!existsSync(file)) continue;
    const mtime = statSync(file).mtimeMs;
    if (mtime > newestSource) newestSource = mtime;
  }
  let oldestOutput = Infinity;
  for (const output of outputs) {
    const mtime = statSync(output).mtimeMs;
    if (mtime < oldestOutput) oldestOutput = mtime;
  }
  return oldestOutput >= newestSource - MTIME_SLACK_MS;
}

/**
 * Build decision used by the launcher: a forced build always runs, otherwise the stage builds
 * only when its outputs are stale or missing relative to its inputs.
 */
export function needsBuild(outputs, sourceDirs, extraFiles, force = false) {
  return force || !buildIsFresh(outputs, sourceDirs, extraFiles);
}
