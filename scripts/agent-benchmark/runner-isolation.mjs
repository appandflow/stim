import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const launcher = '/usr/bin/sandbox-exec';

function canonicalPath(path) {
  if (!isAbsolute(path)) throw new Error('benchmark isolation paths must be absolute');
  try {
    return realpathSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(canonicalPath(dirname(path)), basename(path));
  }
}

function contains(parent, path) {
  const child = relative(parent, path);
  return child === '' || (!child.startsWith('../') && child !== '..' && !isAbsolute(child));
}

function pathFilter(paths) {
  return `(require-any ${paths.map((path) => `(subpath ${JSON.stringify(path)})`).join(' ')})`;
}

export function runnerIsolationPolicy({
  protectedRoots,
  reservedRoots = [],
  readPaths,
  writePaths,
  scopedAccess = {},
}) {
  const roots = [...new Set(protectedRoots.map(canonicalPath))];
  if (roots.length === 0 || roots.includes('/')) throw new Error('benchmark isolation needs bounded protected roots');
  const reserved = reservedRoots.map(canonicalPath);
  const configuredReads = readPaths.map(canonicalPath);
  const configuredWrites = writePaths.map(canonicalPath);
  if (
    [...configuredReads, ...configuredWrites].some((path) =>
      reserved.some((root) => contains(path, root) || contains(root, path)),
    )
  ) {
    throw new Error('benchmark isolation configured grant overlaps a reserved directory');
  }
  const scopedReads = (scopedAccess.readPaths ?? []).map(canonicalPath);
  const scopedWrites = (scopedAccess.writePaths ?? []).map(canonicalPath);
  if ([...scopedReads, ...scopedWrites].some((path) => reserved.some((root) => contains(path, root)))) {
    throw new Error('benchmark isolation scoped grant covers a reserved directory');
  }
  const writes = [...new Set([...configuredWrites, ...scopedWrites])];
  const reads = [...new Set([...configuredReads, ...scopedReads, ...writes])];
  if (reads.some((path) => roots.some((root) => contains(path, root)))) {
    throw new Error('benchmark isolation grant covers a protected root');
  }
  return [
    '(version 1)',
    '(allow default)',
    `(deny file-read-data (require-all ${pathFilter(roots)} (require-not (vnode-type DIRECTORY))${reads.length ? ` (require-not ${pathFilter(reads)})` : ''}))`,
    `(deny file-write* (require-all ${pathFilter(roots)}${writes.length ? ` (require-not ${pathFilter(writes)})` : ''}))`,
    '',
  ].join('\n');
}

const probeScript = `
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const {protectedFiles, allowedFile, alias} = JSON.parse(process.argv[1]);
function denied(fn) {
  try { fn(); } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return;
    throw error;
  }
  throw new Error('protected benchmark access was allowed');
}
for (const file of [...protectedFiles, alias]) {
  denied(() => fs.readFileSync(file));
  denied(() => fs.writeFileSync(file, 'forbidden-write'));
}
for (const file of protectedFiles) fs.readdirSync(require('node:path').dirname(file));
fs.writeFileSync(allowedFile, 'allowed');
if (fs.readFileSync(allowedFile, 'utf8') !== 'allowed') throw new Error('run access failed');
for (const file of protectedFiles) {
  try {
    execFileSync('/bin/cat', [file], {stdio: 'pipe'});
    throw new Error('child read protected benchmark data');
  } catch (error) {
    if (error.status !== 1 || error.stdout.length) throw error;
  }
}
process.stdout.write('benchmark-isolation-verified');
`;

export function prepareRunnerIsolation({ policy, profilePath, probeRoots, probeParent, execute }) {
  if (process.platform !== 'darwin' || !existsSync(launcher)) {
    throw new Error('benchmark isolation requires the verified macOS sandbox launcher');
  }
  mkdirSync(probeParent, { recursive: true });
  const temporary = [];
  try {
    const protectedFiles = probeRoots.map((root) => {
      const directory = mkdtempSync(join(root, '.isolation-probe-'));
      temporary.push(directory);
      const path = join(directory, 'private.txt');
      writeFileSync(path, 'private-benchmark-probe');
      return path;
    });
    const directory = mkdtempSync(join(probeParent, '.isolation-probe-'));
    temporary.push(directory);
    const allowedFile = join(directory, 'allowed.txt');
    const alias = join(directory, 'alias.txt');
    symlinkSync(protectedFiles[0], alias);
    const output = execute(launcher, [
      '-p',
      policy,
      process.execPath,
      '-e',
      probeScript,
      JSON.stringify({ protectedFiles, allowedFile, alias }),
    ]);
    if (output.trim() !== 'benchmark-isolation-verified') throw new Error('benchmark isolation verification failed');
    writeFileSync(profilePath, policy);
    return {
      backend: 'macos-sandbox-exec',
      verified: true,
      profilePath: resolve(profilePath),
      profileSha256: createHash('sha256').update(policy).digest('hex'),
      directoryListings: 'allowed',
    };
  } finally {
    for (const path of temporary) rmSync(path, { recursive: true, force: true });
  }
}

export function isolatedRunnerInvocation(isolation, command, args) {
  const policy = readFileSync(isolation.profilePath, 'utf8');
  if (
    isolation.verified !== true ||
    isolation.backend !== 'macos-sandbox-exec' ||
    createHash('sha256').update(policy).digest('hex') !== isolation.profileSha256
  ) {
    throw new Error('benchmark isolation policy changed after verification');
  }
  return { command: launcher, args: ['-p', policy, command, ...args] };
}
