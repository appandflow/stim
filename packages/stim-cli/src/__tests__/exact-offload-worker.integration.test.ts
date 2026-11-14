import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { recordCreatedDevice } from '../devices/created-devices.ts';
import { teardownOwnedIosSim } from '../devices/teardown.ts';
import { EXACT_SIM_TARGET, exactOffloadParam, exactOffloadPlan } from '../integrations/exact-offload.ts';
import { runOffloadWorker } from '../job/offload/worker.ts';
import { manifestDigest } from '../offload/manifest.ts';
import { sourceManifest } from '../offload/native-source.ts';

vi.mock('../devices/ios.ts', async (actual) => ({
  ...(await actual<typeof import('../devices/ios.ts')>()),
  createOwnedIosSim: vi.fn<typeof import('../devices/ios.ts').createOwnedIosSim>(async () => ({
    udid: 'PROBE-SIM',
    name: 'stim-probe',
    deviceType: null,
    runtime: null,
  })),
  bootIosSim: vi.fn<typeof import('../devices/ios.ts').bootIosSim>(async () => {}),
}));
vi.mock('../engine/device-capacity.ts', async (actual) => ({
  ...(await actual<typeof import('../engine/device-capacity.ts')>()),
  withDeviceBootAdmission: vi.fn<(device: unknown, boot: () => Promise<unknown>) => Promise<unknown>>(
    async (_device, boot) => boot(),
  ),
}));
vi.mock('../devices/teardown.ts', async (actual) => ({
  ...(await actual<typeof import('../devices/teardown.ts')>()),
  teardownOwnedIosSim: vi.fn<typeof import('../devices/teardown.ts').teardownOwnedIosSim>(async () => ({
    status: 'torn-down',
  })),
}));

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
  home = join(root, 'user');
  write(join(home, '.bun-1.4.2', 'bin', 'bun'), '#!/bin/sh\necho 1.4.2\n', 0o755);
  write(join(home, '.cargo', 'bin', 'rustup'), `#!/bin/sh\necho ${EXACT_SIM_TARGET}\n`, 0o755);
  mkdirSync(join(home, '.cargo', 'hermes-lean-sys'));
  const pins = join(home, '.exact', 'exact2', 'pending');
  write(join(pins, 'scripts', 'app-cli.mjs'), '');
  write(join(pins, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.97.0"\n');
  write(join(pins, 'node_modules', 'tool.js'), '');
  write(join(pins, '.gitignore'), 'node_modules/\n');
  git(pins, 'init', '-q');
  git(pins, 'add', '.');
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
  {
    project = '',
    env = {},
    link = null,
  }: { project?: string; env?: Record<string, string>; link?: string | null } = {},
): Promise<{ result: Record<string, unknown>; area: string }> {
  const client = join(root, 'client');
  const blobs = join(root, 'blobs');
  for (const [path, text] of Object.entries(files))
    write(join(client, path), text, path.endsWith('exact.mjs') ? 0o755 : 0o644);
  git(client, 'init', '-q');
  git(client, 'add', '.');
  const manifest = await sourceManifest(client);
  for (const { path, sha256 } of manifest) {
    const text = readFileSync(join(client, path), 'utf8');
    write(join(blobs, sha256.slice(0, 2), sha256), text);
  }
  const exact = project
    ? {
        ...exactOffloadParam(exactOffloadPlan(join(client, project), { EXACT2: join(home, '.exact', 'exact2', sha) })),
        link,
      }
    : { name: 'shop-app', exact2: sha, bun: '1.4.2', rust: '1.97.0', checkout: sha, url: null, env, link };
  expect(exact).not.toBeNull();
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
    exact,
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

const LAUNCHER = '#!/bin/sh\n# ensureBun("1.4.2")\nenv > env-seen.txt\nexit 3\n';

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

test('an Exact app that declares native modules builds next to a simulator the build owns, deleted after', async () => {
  vi.mocked(teardownOwnedIosSim).mockClear();
  recordCreatedDevice('ios', 'LEFT-BY-A-STOPPED-BUILD');
  const { result, area } = await build({
    'exact.mjs': LAUNCHER,
    'app.json': JSON.stringify({ modules: ['shop-map'] }),
  });
  expect(result).toMatchObject({ ok: false, code: 'exact-build-failed' });
  expect(readFileSync(join(area, 'checkout', 'shop-app', 'env-seen.txt'), 'utf8')).toContain('EXACT_SIM=PROBE-SIM\n');
  expect(vi.mocked(teardownOwnedIosSim).mock.calls).toEqual([
    ['LEFT-BY-A-STOPPED-BUILD', { del: true }],
    ['PROBE-SIM', { del: true }],
  ]);
});

test("the app's relative path to exact2 holds a checkout of the pinned commit inside the build area", async () => {
  const placed = (dir: string) => {
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(sha);
    expect(existsSync(join(dir, 'scripts', 'app-cli.mjs'))).toBe(true);
    expect(existsSync(join(dir, 'node_modules', 'tool.js'))).toBe(true);
  };
  const { result, area } = await build(
    { 'exact.mjs': LAUNCHER, 'app.json': '{}' },
    { link: '../../.exact/exact2/scroll-zoom' },
  );
  expect(result).toMatchObject({ ok: false, code: 'exact-build-failed' });
  const at = join(realpathSync(area), '.exact', 'exact2', 'scroll-zoom');
  placed(at);
  expect(readFileSync(join(area, 'checkout', 'shop-app', 'env-seen.txt'), 'utf8')).toContain(`EXACT2=${at}\n`);
  writeFileSync(join(at, 'scripts', 'app-cli.mjs'), 'edited');
  await build({ 'exact.mjs': LAUNCHER, 'app.json': '{}' }, { link: '../../.exact/exact2/scroll-zoom' });
  expect(readFileSync(join(at, 'scripts', 'app-cli.mjs'), 'utf8')).toBe('');

  const sibling = await build({ 'exact.mjs': LAUNCHER, 'app.json': '{}' }, { link: '../exact2' });
  expect(sibling.result).toMatchObject({ ok: false, code: 'exact-build-failed' });
  placed(join(area, 'checkout', 'exact2'));

  const worktree = await build(
    { 'exact.mjs': LAUNCHER, 'app.json': '{}' },
    { link: '../../../../.exact/exact2/scroll-zoom' },
  );
  expect(worktree.result).toMatchObject({ ok: false, code: 'exact-build-failed' });
  expect(readlinkSync(join(area, 'src'))).toBe(join('checkout', 'up', 'up', 'shop-app'));
  expect(existsSync(join(area, 'src', 'env-seen.txt'))).toBe(true);
  placed(at);

  mkdirSync(join(area, 'checkout', 'stray'));
  for (const link of ['../../src/x', '../../home/exact2', '../stray'])
    expect((await build({ 'exact.mjs': LAUNCHER, 'app.json': '{}' }, { link })).result).toMatchObject({
      ok: false,
      code: 'exact-tools',
      message: /cannot place inside its build area|not an exact2 checkout this machine made/,
    });
});

test('the worker refuses a setting app.json does not declare', async () => {
  const { result } = await build(
    { 'exact.mjs': LAUNCHER, 'app.json': JSON.stringify({ env: ['API_URL'] }) },
    { env: { PATH: '/tmp/evil' } },
  );
  expect(result).toMatchObject({ ok: false, code: 'bad-request' });
});

test('an Exact app in a subdirectory builds in the plain checkout, which already carries its folder name', async () => {
  const project = 'apps/\u5e97';
  const { result, area } = await build(
    { [`${project}/exact.mjs`]: LAUNCHER, [`${project}/app.json`]: '{}' },
    { project },
  );
  expect(result).toMatchObject({ ok: false, code: 'exact-build-failed' });
  expect(lstatSync(join(area, 'src')).isDirectory()).toBe(true);
  expect(readdirSync(area)).not.toContain('checkout');
  expect(existsSync(join(area, 'src', project, 'env-seen.txt'))).toBe(true);
});
