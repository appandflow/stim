import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { EXACT_SIM_TARGET } from '../integrations/exact-offload.ts';
import { runOffloadWorker } from '../job/offload/worker.ts';
import { manifestDigest } from '../offload/manifest.ts';

let root: string;
let home: string;
let sha: string;
const saved = { ...process.env };
const stdin = Object.getOwnPropertyDescriptor(process, 'stdin');

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

function write(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-exact-worker-'));
  home = join(root, 'home');
  write(join(home, '.bun-1.4.2', 'bin', 'bun'), '#!/bin/sh\necho 1.4.2\n', 0o755);
  write(join(home, '.cargo', 'bin', 'rustup'), `#!/bin/sh\necho ${EXACT_SIM_TARGET}\n`, 0o755);
  mkdirSync(join(home, '.cargo', 'hermes-lean-sys'));
  const pins = join(home, '.exact', 'exact2', 'pending');
  write(join(pins, 'scripts', 'app-cli.mjs'), '');
  mkdirSync(join(pins, 'node_modules'));
  git(pins, 'init', '-q');
  git(pins, 'add', 'scripts');
  git(pins, 'commit', '-q', '-m', 'pin');
  sha = git(pins, 'rev-parse', 'HEAD');
  execFileSync('mv', [pins, join(home, '.exact', 'exact2', sha)]);
  Object.assign(process.env, {
    HOME: home,
    STIM_HOME: join(root, 'stim-home'),
    BUN: '/elsewhere/bun',
    CARGO_TARGET_DIR: '/elsewhere/target',
    EXACT_SIM: 'SOMEONE-ELSES-SIM',
    EXACT_PORT: '9999',
    API_URL: 'worker-value',
  });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  if (stdin) Object.defineProperty(process, 'stdin', stdin);
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** Runs the worker's build mode on the files under `client`, as stim-server hands it a synced manifest. */
async function build(
  files: Record<string, string>,
  { project = '', env = {} }: { project?: string; env?: Record<string, string> } = {},
): Promise<{ result: Record<string, unknown>; area: string }> {
  const client = join(root, 'client');
  const blobs = join(root, 'blobs');
  const manifest = Object.entries(files).map(([path, text]) => {
    const sha256 = createHash('sha256').update(text).digest('hex');
    write(join(blobs, sha256.slice(0, 2), sha256), text);
    write(join(client, path), text);
    return { path, kind: path.endsWith('exact.mjs') ? 'exec' : 'file', size: Buffer.byteLength(text), sha256 };
  });
  const area = join(root, 'area');
  mkdirSync(area, { recursive: true });
  const job = {
    job: 'job-1',
    area,
    blobs,
    manifest,
    platform: 'ios',
    macos: null,
    swiftpmCache: join(root, 'swiftpm'),
    project,
    isExpo: false,
    configuration: null,
    scheme: null,
    runtime: null,
    android: null,
    expectedFingerprint: manifestDigest(manifest),
    exact: { name: 'shop-app', exact2: sha, bun: '1.4.2', rust: '1.97.0', env },
    optimizations: null,
    compat: 5,
  };
  Object.defineProperty(process, 'stdin', {
    value: Readable.from([Buffer.from(JSON.stringify(job))]),
    configurable: true,
  });
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  await runOffloadWorker('build');
  const result = lines.map((line) => JSON.parse(line)).find((each) => each.type === 'result');
  if (result.code === 'worker-crashed') throw new Error(String(result.message));
  return { result, area };
}

const LAUNCHER = '#!/bin/sh\nenv > env-seen.txt\nexit 3\n';

test('the worker runs Exact without the simulator, the worker caches or Exact settings of its own environment', async () => {
  const { result, area } = await build(
    { 'exact.mjs': LAUNCHER, 'app.json': JSON.stringify({ env: ['API_URL', 'STORE_ID'] }) },
    { env: { API_URL: 'client-value' } },
  );
  expect(result).toMatchObject({ ok: false, code: 'exact-build-failed' });
  expect(lstatSync(join(area, 'src')).isSymbolicLink()).toBe(true);
  const seen = Object.fromEntries(
    readFileSync(join(area, 'checkout', 'shop-app', 'env-seen.txt'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  expect(seen).toMatchObject({ API_URL: 'client-value', EXACT2: join(home, '.exact', 'exact2', sha) });
  for (const name of ['BUN', 'CARGO_TARGET_DIR', 'EXACT_SIM', 'EXACT_PORT', 'STORE_ID'])
    expect(seen).not.toHaveProperty(name);
});

test('the worker refuses an Exact app that declares native modules before running anything', async () => {
  const { result, area } = await build({
    'exact.mjs': LAUNCHER,
    'app.json': JSON.stringify({ modules: ['shop-map'] }),
  });
  expect(result).toMatchObject({ ok: false, code: 'exact-modules' });
  expect(existsSync(join(area, 'checkout', 'shop-app', 'env-seen.txt'))).toBe(false);
});

test('the worker refuses a setting app.json does not declare', async () => {
  const { result } = await build(
    { 'exact.mjs': LAUNCHER, 'app.json': JSON.stringify({ env: ['API_URL'] }) },
    { env: { PATH: '/tmp/evil' } },
  );
  expect(result).toMatchObject({ ok: false, code: 'bad-request' });
});

test('an Exact app in a subdirectory builds in the plain checkout, which already carries its folder name', async () => {
  const { result, area } = await build(
    { 'apps/shop-app/exact.mjs': LAUNCHER, 'apps/shop-app/app.json': '{}' },
    { project: 'apps/shop-app' },
  );
  expect(result).toMatchObject({ ok: false, code: 'exact-build-failed' });
  expect(lstatSync(join(area, 'src')).isDirectory()).toBe(true);
  expect(readdirSync(area)).not.toContain('checkout');
  expect(existsSync(join(area, 'src', 'apps', 'shop-app', 'env-seen.txt'))).toBe(true);
});
