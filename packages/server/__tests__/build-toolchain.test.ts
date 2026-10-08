import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      '  cocoapods: response.cocoapods',
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

test('offer validation rejects path and line-break inputs while accepting normalized installation names', async () => {
  const validate = new Ajv2020({ strict: false }).compile({
    ...protocolJsonSchema(),
    $ref: '#/$defs/ClientRequest',
  });
  for (const rubyVersion of ['', '.', '..', '../3.3.4', 'a\\b', '3.3.4\n', '3.3.4\r\n', 'a\u0000b', 7]) {
    const params = { repo: 'app', rubyVersion };
    expect(validate({ id: '1', method: 'build.offer', params })).toBe(false);
    expect(await host.offer('client', params)).toMatchObject({ error: { code: 'bad-request' } });
  }
  for (const rubyVersion of ['3.3.4', 'truffleruby+graalvm-21.3', 'a'.repeat(81)]) {
    expect(validate({ id: '1', method: 'build.offer', params: { repo: 'app', rubyVersion } })).toBe(true);
  }
});
