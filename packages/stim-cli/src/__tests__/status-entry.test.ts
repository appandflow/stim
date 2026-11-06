import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/status-entry.ts';

const cli = vi.hoisted(() => {
  Reflect.set(globalThis, Symbol.for('stim.main'), true);
  return { main: vi.fn<(argv: string[], ctx: object) => Promise<void>>(async () => {}) };
});
vi.mock('../../bin/node-check.ts', () => cli);

let home: string;
let server: Server | null = null;
let requests: Record<string, unknown>[];
let stdout: string[];

/** A stimd that answers its first frame with `hello`, unless `first` replaces it, and `status` with `answer`. */
function stimd(answer: Record<string, unknown>, first: Record<string, unknown> = { op: 'hello' }): Promise<void> {
  const socket =
    process.platform === 'win32' ? `\\\\.\\pipe\\stim-status-entry-${process.pid}` : join(home, 'stimd.sock');
  writeFileSync(join(home, 'run', 'stimd.json'), JSON.stringify({ socket }));
  server = createServer((connection) => {
    let buffer = '';
    connection.on('data', (chunk) => {
      buffer += String(chunk);
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        requests.push(message);
        if (message.kind) connection.write(`${JSON.stringify(first)}\n`);
        else connection.end(`${JSON.stringify(answer)}\n`);
      }
    });
  });
  return new Promise((done) => server?.listen(socket, done));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-status-entry-'));
  mkdirSync(join(home, 'run'));
  process.env.STIM_HOME = home;
  requests = [];
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((text) => (stdout.push(String(text)), true));
});

afterEach(async () => {
  await new Promise((done) => (server ? server.close(done) : done(undefined)));
  server = null;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  cli.main.mockClear();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

const printed = () => JSON.parse(stdout.join(''));

test('--json prints the snapshot stimd answers for this directory, with its age, and loads no CLI', async () => {
  await stimd({ op: 'status', ageMs: 4200, status: { environments: [], daemon: { running: true } } });
  await main(['node', 'stim', 'status', '--json']);
  expect(printed()).toEqual({ environments: [], daemon: { running: true }, ageMs: 4200 });
  expect(requests).toEqual([
    { kind: 'cli', build: expect.stringMatching(/^[0-9a-f]{12}$/) },
    { op: 'status', params: { cwd: process.cwd(), fresh: false, env: expect.any(Object) } },
  ]);
  expect(cli.main).not.toHaveBeenCalled();
});

test('--json says booting while stimd has no snapshot, and --fresh asks stimd to read the state first', async () => {
  await stimd({ op: 'status', ageMs: null, booting: true, status: null });
  await main(['node', 'stim', 'status', '--json', '--fresh']);
  expect(printed()).toEqual({ ageMs: null, booting: true });
  expect(requests[1]).toMatchObject({ op: 'status', params: { cwd: process.cwd(), fresh: true } });
});

test.each([
  ['the human form', ['status'], { op: 'status', ageMs: 1, status: {} }],
  ['--watch', ['status', '--json', '--watch'], { op: 'status', ageMs: 1, status: {} }],
  ['an option the entry does not know', ['status', '--json', '--help'], { op: 'status', ageMs: 1, status: {} }],
  ['a stimd that could not read the state', ['status', '--json'], { op: 'status', error: 'simctl hung' }],
])('%s runs the status command of the CLI', async (_name, args, answer) => {
  await stimd(answer);
  await main(['node', 'stim', ...args]);
  expect(stdout).toEqual([]);
  expect(cli.main).toHaveBeenCalledWith(['node', 'stim', ...args], {});
});

test('--json runs the CLI, which refuses it, when a Stim path override is relative', async () => {
  await stimd({ op: 'status', ageMs: 1, status: {} });
  vi.stubEnv('STIM_BUILD_CACHE', 'relative/cache');
  await main(['node', 'stim', 'status', '--json']);
  expect(requests).toEqual([]);
  expect(cli.main).toHaveBeenCalledTimes(1);
});

test('--json runs the CLI when no stimd runs or a stimd of another build refuses this one', async () => {
  await main(['node', 'stim', 'status', '--json']);
  expect(cli.main).toHaveBeenCalledTimes(1);
  await stimd({ op: 'status', ageMs: 1, status: {} }, { op: 'engine-changed', build: 'aaaaaaaaaaaa' });
  await main(['node', 'stim', 'status', '--json']);
  expect(cli.main).toHaveBeenCalledTimes(2);
  expect(stdout).toEqual([]);
});
