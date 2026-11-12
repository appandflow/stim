import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { metroExitFile, readNdjsonGenerations } from '@stim-cli/core/state';
import { inspectProcessIdentity, waitForProcessExit } from '@stim-cli/core/process-identity';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { upsertProject } from '../workspace/config.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { adoptMetroChildren, closeMetroChildren, metroTick, openMetroChildren } from '../stimd/metro/children.ts';
import { spawnEntry } from '../spawn-entry.ts';

const SERVER = `
const http = require('node:http');
const { spawn } = require('node:child_process');
const port = Number(process.argv[2]);
http.createServer((req, res) => res.end('packager-status:running')).listen(port, '127.0.0.1');
console.log('server listening');
process.on('SIGUSR2', () => {
  for (let i = 0; i < 50; i++) console.log('line ' + i);
  spawn(process.execPath, ['-e', "setTimeout(() => console.log('after the leader'), 300)"], { stdio: ['ignore', 'inherit', 'inherit'] });
  process.exit(7);
});
`;

/** A stimd stand-in: starts the workspace's dev server through stimd's Metro code, prints the answer, and waits. */
const STIMD = (root: string, port: number) => `
const { openMetroChildren, ensureMetro } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'stimd', 'metro', 'children.ts')).href)});
openMetroChildren();
process.stdout.write(JSON.stringify(await ensureMetro({ root: ${JSON.stringify(root)}, port: ${port} }, () => {})) + '\\n');
setInterval(() => {}, 1000);
`;

let home: string;
let root: string;
const spawned: ChildProcess[] = [];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-metro-helper-')));
  vi.stubEnv('STIM_HOME', home);
  root = join(home, 'project');
  mkdirSync(root);
  writeFileSync(join(root, 'server.cjs'), SERVER);
  writeFileSync(join(root, '.stim.json'), JSON.stringify({ metro: { command: ['node', 'server.cjs', '{port}'] } }));
});

afterEach(async () => {
  for (const child of spawned.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** Starts the dev server from a stimd stand-in, then kills that stimd with SIGKILL, as a crash would. */
async function startThenCrashStimd(port: number): Promise<{ pid: number }> {
  upsertProject(root, { metroPort: port });
  const stimd = spawn(process.execPath, ['--input-type=module', '-e', STIMD(root, port)], {
    env: { ...process.env, STIM_HOME: home },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  spawned.push(stimd);
  const [line] = (await once(stimd.stdout!, 'data')) as [Buffer];
  const answer = JSON.parse(line.toString()) as { op: string; pid: number };
  expect(answer).toMatchObject({ op: 'metro', state: 'started' });
  stimd.kill('SIGKILL');
  await once(stimd, 'exit');
  return answer;
}

const records = () =>
  readNdjsonGenerations(join(workspaceLogsDir(root), 'metro.ndjson')).filter((record) => record.src === 'metro');

describe.skipIf(process.platform === 'win32')('the dev-server helper', () => {
  test('a dev server adopted after a stimd crash keeps its complete output and its exit code, across a rotation', async () => {
    mkdirSync(workspaceLogsDir(root), { recursive: true });
    const filler = `${JSON.stringify({ ts: 1, src: 'metro', msg: 'x'.repeat(1000) })}\n`;
    writeFileSync(
      join(workspaceLogsDir(root), 'metro.ndjson'),
      filler.repeat(Math.ceil(LOG_ROTATE_BYTES / filler.length)),
    );
    const { pid } = await startThenCrashStimd(8291);
    openMetroChildren();
    try {
      adoptMetroChildren(() => {});
      process.kill(pid, 'SIGUSR2');
      await vi.waitFor(() => expect(existsSync(metroExitFile(root))).toBe(true), { timeout: 10_000 });
      await metroTick('on', () => {});
      const lines = records().map((record) => String(record.msg));
      for (let i = 0; i < 50; i++) expect(lines.filter((msg) => msg === `line ${i}`)).toHaveLength(1);
      expect(lines).toContain('after the leader');
      expect(records().filter((record) => record.event === 'supervisor_stopped')).toMatchObject([
        { level: 'error', stop: { reason: 'server-exited', code: 7 } },
      ]);
      expect(readWorkspaceState(root)?.devServerStop).toMatchObject({ reason: 'server-exited', code: 7 });
      expect(existsSync(metroExitFile(root))).toBe(false);
      const file = join(workspaceLogsDir(root), 'metro.ndjson');
      for (const generation of [`${file}.1`, file])
        for (const line of readFileSync(generation, 'utf8').split('\n').filter(Boolean))
          expect(() => JSON.parse(line)).not.toThrow();
      expect(readFileSync(`${file}.1`, 'utf8')).toContain('supervisor_started');
      expect(readFileSync(file, 'utf8')).toContain('line 0');
    } finally {
      await closeMetroChildren();
    }
  }, 30_000);

  test('an exit recorded while no stimd ran is settled by the next one', async () => {
    const { pid } = await startThenCrashStimd(8292);
    process.kill(pid, 'SIGUSR2');
    await vi.waitFor(() => expect(existsSync(metroExitFile(root))).toBe(true), { timeout: 10_000 });
    expect(readClaimSet(join(workspaceDir(root), 'metro.claim')).live).toEqual([]);
    openMetroChildren();
    try {
      adoptMetroChildren(() => {});
      expect(records().filter((record) => record.event === 'supervisor_stopped')).toMatchObject([
        { stop: { reason: 'server-exited', code: 7 } },
      ]);
      expect(readWorkspaceState(root)?.supervisor).toBeUndefined();
      expect(existsSync(metroExitFile(root))).toBe(false);
    } finally {
      await closeMetroChildren();
    }
  }, 30_000);

  test("Expo's tunnel URL is recorded once however often Expo prints it", async () => {
    mkdirSync(workspaceLogsDir(root), { recursive: true });
    const print =
      "console.log('Waiting on exp://abc123.exp.direct'); console.log('Waiting on exp://abc123.exp.direct')";
    const helper = spawn(
      process.execPath,
      [spawnEntry('metro-run'), root, 'expo-child', '--tunnel', '--', process.execPath, '-e', print],
      { cwd: root, env: { ...process.env, STIM_HOME: home }, stdio: 'ignore' },
    );
    spawned.push(helper);
    const [code] = (await once(helper, 'exit')) as [number];
    expect(code).toBe(0);
    expect(records().filter((record) => record.event === 'expo_tunnel_ready')).toMatchObject([
      { msg: 'Expo tunnel ready: https://abc123.exp.direct' },
    ]);
    expect(JSON.parse(readFileSync(metroExitFile(root), 'utf8'))).toMatchObject({ code: 0, signal: null });
  }, 30_000);

  test('a stopped dev server leaves no helper behind', async () => {
    const { pid } = await startThenCrashStimd(8293);
    openMetroChildren();
    const helper = readClaimSet(join(workspaceDir(root), 'metro.claim')).live[0]?.details.helper as {
      pid: number;
      processToken: string;
    };
    expect(inspectProcessIdentity(helper)).toBe('same');
    adoptMetroChildren(() => {});
    process.kill(pid, 'SIGTERM');
    expect(await waitForProcessExit(helper, 10_000)).toBe(true);
    await metroTick('on', () => {});
    expect(records().filter((record) => record.event === 'supervisor_stopped')).toMatchObject([
      { stop: { reason: 'server-exited', signal: 'SIGTERM' } },
    ]);
    await closeMetroChildren();
  }, 30_000);
});
