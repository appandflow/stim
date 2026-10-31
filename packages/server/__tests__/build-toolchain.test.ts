import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { BuildHost } from '../src/build.ts';
import { protocolJsonSchema } from '../src/protocol.ts';

let root: string;
let host: BuildHost;
let now: number;
let pending: Promise<unknown>[];
let held: Set<string>;

type Response = { cocoapods: string; hold?: boolean; invalid?: boolean };

function response(context: string, value: Response): void {
  if (value.hold) held.add(context);
  writeFileSync(join(root, context + '.json'), JSON.stringify(value));
}

async function started(context: string): Promise<void> {
  for (let i = 0; i < 100 && !existsSync(join(root, context + '.started')); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(existsSync(join(root, context + '.started'))).toBe(true);
}

function request(rubyVersion?: string): ReturnType<BuildHost['offer']> {
  const result = host.offer('client', { repo: 'app', ...(rubyVersion ? { rubyVersion } : {}) });
  pending.push(result);
  return result;
}

async function offered(rubyVersion?: string): Promise<string | null> {
  const reply = await request(rubyVersion);
  assert('result' in reply);
  return reply.result.toolchain.cocoapods;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-offer-toolchain-'));
  pending = [];
  held = new Set();
  vi.stubEnv('STIM_HOME', join(root, 'home'));
  mkdirSync(process.env.STIM_HOME!, { recursive: true });
  now = 100;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const worker = join(root, 'worker.mjs');
  writeFileSync(
    worker,
    [
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { dirname, join } from 'node:path';",
      'const root = dirname(process.argv[1]);',
      "const context = process.argv[3] ?? 'default';",
      "const response = JSON.parse(readFileSync(join(root, context + '.json'), 'utf8'));",
      "writeFileSync(join(root, context + '.started'), '');",
      "while (response.hold && !existsSync(join(root, context + '.release'))) {",
      '  await new Promise(resolve => setTimeout(resolve, 10));',
      '}',
      "console.log(response.invalid ? 'invalid JSON' : JSON.stringify({",
      "  stimBuild: 'b1', arch: 'arm64', xcode: 'Xcode 27.0', simulatorSdk: '27.0',",
      "  macosSdk: '27.0', runtimes: [], jdk: null, androidSdk: null,",
      '  cocoapods: process.env.FIXTURE_POD ?? response.cocoapods',
      '}));',
    ].join('\n'),
  );
  response('default', { cocoapods: '1.17.0' });
  response('3.3.4', { cocoapods: '1.16.2' });
  response('3.4.8', { cocoapods: '1.17.0' });
  host = new BuildHost({ worker, env: process.env });
});

afterEach(async () => {
  for (const context of held) writeFileSync(join(root, context + '.release'), '');
  await Promise.allSettled(pending);
  await host.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

test('dependency warmth requires the requested install; directories and pruned state do not advertise caches', async () => {
  const area = join(host.clientDir('client'), 'repos', 'app');
  const checkout = join(area, 'src');
  const project = 'apps/mobile';
  const modules = join(checkout, 'node_modules');
  const lockfile = 'lockfile fixture';
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const marker = sha(lockfile + JSON.stringify(['install', '--frozen-lockfile']) + 'node path');
  mkdirSync(modules, { recursive: true });
  mkdirSync(join(checkout, project), { recursive: true });
  mkdirSync(join(area, 'macos'), { recursive: true });
  writeFileSync(join(area, 'macos', 'unrelated'), 'not a compiler cache');
  writeFileSync(join(checkout, 'pnpm-lock.yaml'), lockfile);
  writeFileSync(join(area, 'lockfile'), sha(lockfile));
  writeFileSync(join(area, 'dependencies'), marker);
  const params = { repo: 'app', lockfile: sha(lockfile), dependencies: { project, packageName: 'mobile' } };
  const validate = new Ajv2020({ strict: false }).compile({ ...protocolJsonSchema(), $ref: '#/$defs/ClientRequest' });
  expect(validate({ id: '1', method: 'build.offer', params })).toBe(true);
  for (const dependencies of [
    null,
    {},
    { project },
    { project: 7, packageName: null },
    { project, packageName: false },
  ]) {
    expect(validate({ id: '1', method: 'build.offer', params: { ...params, dependencies } })).toBe(false);
    expect(await host.offer('client', { ...params, dependencies })).toHaveProperty('error.code', 'bad-request');
  }
  const warmth = async (query = params) => {
    const reply = await host.offer('client', query);
    assert('result' in reply);
    return reply.result.warm;
  };
  expect(await warmth()).toEqual({ checkout: true, dependencies: true, build: false });
  mkdirSync(join(checkout, 'apps', 'other'), { recursive: true });
  expect(await warmth({ ...params, dependencies: { project: 'apps/other', packageName: 'other' } })).toHaveProperty(
    'dependencies',
    true,
  );
  expect(await host.offer('client', { repo: 'app', lockfile: sha(lockfile) })).toHaveProperty(
    'result.warm.dependencies',
    false,
  );
  rmSync(modules, { recursive: true });
  expect(await warmth()).toHaveProperty('dependencies', false);
  mkdirSync(modules);
  writeFileSync(join(checkout, 'pnpm-lock.yaml'), 'new lockfile');
  expect(await warmth()).toHaveProperty('dependencies', false);
  writeFileSync(join(checkout, 'pnpm-lock.yaml'), lockfile);
  rmSync(join(area, 'dependencies'));
  expect(await warmth()).toHaveProperty('dependencies', false);
  writeFileSync(join(area, 'dependencies'), marker);
  const outside = join(root, 'outside');
  mkdirSync(join(outside, 'node_modules'), { recursive: true });
  symlinkSync(outside, join(checkout, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(await warmth({ ...params, dependencies: { project: 'linked', packageName: 'mobile' } })).toHaveProperty(
    'dependencies',
    false,
  );
  const standalone = { project: 'standalone', packageName: 'standalone' };
  mkdirSync(join(checkout, 'standalone', 'node_modules'), { recursive: true });
  writeFileSync(join(checkout, 'standalone', 'package-lock.json'), 'standalone lockfile');
  writeFileSync(
    join(area, `dependencies-${sha('standalone').slice(0, 16)}`),
    sha('standalone lockfile' + JSON.stringify(['ci']) + 'node path'),
  );
  expect(await warmth({ repo: 'app', lockfile: sha('standalone lockfile'), dependencies: standalone })).toHaveProperty(
    'dependencies',
    true,
  );
  expect(await warmth({ ...params, dependencies: standalone })).toHaveProperty('dependencies', false);
  expect(await warmth()).toHaveProperty('dependencies', true);
  rmSync(checkout, { recursive: true });
  expect(await warmth()).toEqual({ checkout: false, dependencies: false, build: false });
});

test('older offers without Ruby context work and each context keeps its report for the existing 60 seconds', async () => {
  expect(await offered()).toBe('1.17.0');
  expect(await offered('3.3.4')).toBe('1.16.2');
  response('default', { cocoapods: '1.18.0' });
  response('3.3.4', { cocoapods: '1.19.0' });
  expect(await offered('3.4.8')).toBe('1.17.0');
  now += 59_999;
  expect(await offered()).toBe('1.17.0');
  expect(await offered('3.3.4')).toBe('1.16.2');
  now++;
  expect(await offered()).toBe('1.18.0');
  expect(await offered('3.3.4')).toBe('1.19.0');
});

test('a report taken after its expiry sees the tools installed since the server started', async () => {
  let installed = 'none-at-start';
  await host.close();
  host = new BuildHost({
    worker: join(root, 'worker.mjs'),
    env: { ...process.env, FIXTURE_POD: installed },
    currentEnv: () => ({ ...process.env, FIXTURE_POD: installed }),
  });
  expect(await offered()).toBe('none-at-start');
  installed = '1.17.0';
  now += 59_999;
  expect(await offered()).toBe('none-at-start');
  now++;
  expect(await offered()).toBe('1.17.0');
});

test('concurrent Ruby contexts stay separate and a same-context caller joins its in-flight probe', async () => {
  response('3.3.4', { cocoapods: '1.16.2', hold: true });
  response('3.4.8', { cocoapods: '1.17.0', hold: true });
  const first = offered('3.3.4');
  const other = offered('3.4.8');
  await Promise.all([started('3.3.4'), started('3.4.8')]);
  response('3.3.4', { cocoapods: '1.20.0' });
  const same = offered('3.3.4');
  writeFileSync(join(root, '3.3.4.release'), '');
  writeFileSync(join(root, '3.4.8.release'), '');
  expect(await Promise.all([first, other, same])).toEqual(['1.16.2', '1.17.0', '1.16.2']);
});

test('an expired failing probe cannot invalidate the replacement report', async () => {
  response('3.3.4', { cocoapods: '1.16.2', hold: true, invalid: true });
  const old = request('3.3.4');
  await started('3.3.4');
  now += 60_000;
  response('3.3.4', { cocoapods: '1.16.2' });
  expect(await offered('3.3.4')).toBe('1.16.2');
  writeFileSync(join(root, '3.3.4.release'), '');
  expect(await old).toMatchObject({ error: { code: 'build-refused' } });
  response('3.3.4', { cocoapods: '1.20.0' });
  expect(await offered('3.3.4')).toBe('1.16.2');
});
