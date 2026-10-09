#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultRepository = 'Belttz/flarestar-quant';
const versionPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseVersion(value) {
  const match = versionPattern.exec(value);
  if (!match) return null;
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: match[4]?.split('.') ?? [],
  };
}

function comparePrereleaseIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber === rightNumber ? 0 : leftNumber > rightNumber ? 1 : -1;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : left > right ? 1 : -1;
}

export function compareVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  if (!left || !right) return null;

  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] > right.core[index] ? 1 : -1;
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const comparison = comparePrereleaseIdentifier(left.prerelease[index], right.prerelease[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function validRepository(value) {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function sourceSettings() {
  try {
    return await readJson(resolve(root, '.gate-crossex-source.json'));
  } catch {
    return null;
  }
}

export async function checkForUpdate({
  fetchImpl = fetch,
  timeoutMs = 2500,
  environment = process.env,
  savedSource,
} = {}) {
  const manifest = await readJson(resolve(root, 'package.json'));
  const currentVersion = typeof manifest.version === 'string' ? manifest.version : '';
  if (!parseVersion(currentVersion)) return null;

  const source = savedSource === undefined ? await sourceSettings() : savedSource;
  const configuredRef = environment.GCT_SOURCE_REF || source?.ref;
  if (configuredRef && configuredRef !== 'main' && configuredRef !== 'master') return null;

  const repository = environment.GCT_REPO_SLUG || source?.repository || defaultRepository;
  if (!validRepository(repository)) return null;

  const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'gate-crossex-update-check',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return null;
  const release = await response.json();
  const latestTag = typeof release.tag_name === 'string' ? release.tag_name : '';
  if (!parseVersion(latestTag) || compareVersions(latestTag, currentVersion) !== 1) return null;
  return { currentVersion, latestTag };
}

async function main() {
  try {
    const update = await checkForUpdate();
    if (update) process.stdout.write(`${update.currentVersion}\t${update.latestTag}\n`);
  } catch {
    // Startup must remain available when GitHub, DNS, or the local network is unavailable.
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
