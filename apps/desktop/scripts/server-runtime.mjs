import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = 'v24.21.0';
const NODE_SHA256 = {
  arm64: '6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe',
  x64: '0ae5a24c24bb7d015cd816c5036b3f90f2945aa872fcf54e58da054753b3a299',
};
const PACKAGES = ['core', 'cache', 'metro', 'stim-cli', 'server'];

const usage = 'usage: node scripts/server-runtime.mjs <destination> [--universal]';
const args = process.argv.slice(2);
const universal = args.includes('--universal');
const positional = args.filter((arg) => arg !== '--universal');
if (positional.length !== 1 || args.some((arg) => arg.startsWith('-') && arg !== '--universal')) {
  console.error(usage);
  process.exit(1);
}
const destination = resolve(positional[0]);
const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(desktop, '../..');
const cache = join(desktop, '.build/node', NODE_VERSION);
const run = (file, argv, options = {}) =>
  execFileSync(file, argv, {
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  });
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function download(url, path) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
}

async function nodeBinary(arch) {
  const name = `node-${NODE_VERSION}-darwin-${arch}`;
  const binary = join(cache, arch, 'node');
  mkdirSync(join(cache, arch), { recursive: true });
  const sums = join(cache, 'SHASUMS256.txt');
  if (!existsSync(sums)) await download(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`, sums);
  const listed = readFileSync(sums, 'utf8').match(new RegExp(`^([0-9a-f]{64})  ${name}\\.tar\\.xz$`, 'm'))?.[1];
  if (listed !== NODE_SHA256[arch]) {
    throw new Error(
      `nodejs.org SHASUMS256.txt lists ${listed ?? 'nothing'} for ${name}.tar.xz, not the pinned ${NODE_SHA256[arch]}`,
    );
  }
  const archive = join(cache, `${name}.tar.xz`);
  if (!existsSync(archive) || sha256(archive) !== NODE_SHA256[arch]) {
    await download(`https://nodejs.org/dist/${NODE_VERSION}/${name}.tar.xz`, archive);
  }
  const actual = sha256(archive);
  if (actual !== NODE_SHA256[arch]) {
    rmSync(archive);
    throw new Error(`${name}.tar.xz has SHA-256 ${actual}, not ${NODE_SHA256[arch]}`);
  }
  const extract = mkdtempSync(join(tmpdir(), 'stim-node-'));
  try {
    run('/usr/bin/tar', ['-xJf', archive, '-C', extract, `${name}/bin/node`, `${name}/LICENSE`]);
    copyFileSync(join(extract, name, 'LICENSE'), join(cache, 'LICENSE'));
    const stripped = join(extract, 'node');
    run('/usr/bin/xcrun', ['strip', '-x', join(extract, name, 'bin/node'), '-o', stripped], { stdio: 'ignore' });
    copyFileSync(stripped, binary);
    chmodSync(binary, 0o755);
  } finally {
    rmSync(extract, { recursive: true, force: true });
  }
  return binary;
}

async function stageNode(bin) {
  mkdirSync(bin, { recursive: true });
  const node = join(bin, 'node');
  if (universal) {
    const [arm64, x64] = [await nodeBinary('arm64'), await nodeBinary('x64')];
    run('/usr/bin/lipo', ['-create', arm64, x64, '-output', node]);
  } else {
    copyFileSync(await nodeBinary(process.arch === 'x64' ? 'x64' : 'arm64'), node);
  }
  run('/usr/bin/codesign', ['--force', '--sign', '-', node], {
    stdio: 'ignore',
  });
  copyFileSync(join(cache, 'LICENSE'), join(bin, 'node-LICENSE'));
  return node;
}

function packWorkspace(into) {
  run('pnpm', ['--filter', '@stim-cli/server...', 'run', 'build'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const contents = new Map();
  for (const dir of PACKAGES) {
    const path = join(root, 'packages', dir);
    const out = join(into, dir);
    mkdirSync(out);
    run('pnpm', ['pack', '--pack-destination', out], {
      cwd: path,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const file = readdirSync(out).find((entry) => entry.endsWith('.tgz'));
    if (!file) throw new Error(`pnpm pack wrote no package file for ${dir}`);
    run('/usr/bin/tar', ['-xzf', join(out, file), '-C', out]);
    contents.set(realpathSync(path), join(out, 'package'));
  }
  return contents;
}

function lockedTree() {
  const [server] = JSON.parse(
    run('pnpm', ['list', '--prod', '--depth', 'Infinity', '--json', '--filter', '@stim-cli/server'], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    }).toString(),
  );
  const dependencies = new Map([[server.path, server.dependencies]]);
  const index = (deps) => {
    for (const info of Object.values(deps ?? {})) {
      if (info.dependencies) dependencies.set(info.path, info.dependencies);
      index(info.dependencies);
    }
  };
  index(server.dependencies);
  return { server, dependencies };
}

function install(modules, contents) {
  const { server, dependencies } = lockedTree();
  const placed = new Map();
  const lookup = (dest) => {
    const dirs = [join(dest, 'node_modules')];
    for (let dir = dirname(dest); dir.startsWith(modules); dir = dirname(dir)) {
      if (basename(dir) === 'node_modules') dirs.push(dir);
    }
    return dirs;
  };
  const visible = (name, dirs) => {
    for (const dir of dirs) {
      const there = placed.get(join(dir, name));
      if (there) return there.source;
    }
    return null;
  };
  const copy = (name, info, dirs) => {
    const source = realpathSync(info.path);
    const seen = visible(name, dirs);
    if (seen === source) return null;
    const dest = join(seen ? dirs[0] : modules, name);
    placed.set(dest, { source, key: info.path });
    const from = contents.get(source);
    if (from) {
      cpSync(from, dest, { recursive: true });
    } else {
      const own = join(source, 'node_modules');
      cpSync(source, dest, {
        recursive: true,
        filter: (path) => path !== own && !path.startsWith(`${own}/`),
      });
    }
    return { key: info.path, dest };
  };
  const placeDependencies = (parent) => {
    const dirs = lookup(parent.dest);
    const children = Object.entries(dependencies.get(parent.key) ?? {})
      .map(([name, info]) => copy(name, info, dirs))
      .filter(Boolean);
    for (const child of children) placeDependencies(child);
  };
  placeDependencies(copy(server.name, server, [modules]));
  for (const [dest, { key }] of placed) {
    for (const [name, info] of Object.entries(dependencies.get(key) ?? {})) {
      const resolved = visible(name, lookup(dest));
      if (resolved !== realpathSync(info.path)) {
        throw new Error(`${dest} would load ${name} from ${resolved ?? 'nowhere'}, not ${info.path}`);
      }
    }
  }
}

function pruneOtherPlatforms(modules) {
  const prebuilds = join(modules, 'unique-pid/prebuilds');
  for (const entry of readdirSync(prebuilds)) {
    if (entry !== 'darwin-arm64' && entry !== 'darwin-x64') rmSync(join(prebuilds, entry), { recursive: true });
  }
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
const node = await stageNode(join(destination, 'bin'));
const packs = mkdtempSync(join(tmpdir(), 'stim-server-packs-'));
try {
  install(join(destination, 'node_modules'), packWorkspace(packs));
} finally {
  rmSync(packs, { recursive: true, force: true });
}
pruneOtherPlatforms(join(destination, 'node_modules'));
const script = join(destination, 'node_modules/@stim-cli/server/dist/stim-server.mjs');
const expected = JSON.parse(readFileSync(join(root, 'packages/server/package.json'), 'utf8')).version;
const reported = run(node, [script, '--version'], {
  env: { HOME: process.env.HOME ?? '' },
})
  .toString()
  .trim();
if (reported !== expected) throw new Error(`the staged stim-server reports ${reported}, not ${expected}`);
console.log(destination);
