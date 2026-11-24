import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runServiceStopPass } from '../daemon/service-stops.ts';
import * as services from '../services.ts';
import { serviceRecords } from '../services.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import * as listeners from '../listening-ports.ts';
import { getProject, loadConfig, saveConfig, upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage } from '../workspace/paths.ts';
import * as runningFrom from '../workspace/running-from.ts';
import type { RunningProcesses } from '../workspace/running-from.ts';
import type { ProjectRecord } from '../workspace/config.ts';
import { recordWorkspaceUse, updateWorkspaceState } from '../workspace/workspace-state.ts';
import { testContext } from './_context.ts';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const EXTERNAL_PID = 4242;

let base: string;
let root: string;
let externalCwd: string | null;
let listening: Set<number>;
let runs: string[][];

const git = (cwd: string, ...args: string[]) => {
  const when = new Date(Date.now() - 3 * DAY_MS).toISOString();
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
};

function age(path: string, when: Date) {
  if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) age(join(path, name), when);
  utimesSync(path, when, when);
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-port-stops-')));
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  vi.stubEnv('HOME', join(base, 'user'));
  mkdirSync(join(base, 'user'), { recursive: true });
  saveConfig({ version: 2, projects: {}, repos: {} });
  root = join(base, 'app');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), '{}');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  externalCwd = null;
  listening = new Set([8900]);
  runs = [];
  const table = (): RunningProcesses => ({
    commands: [{ pid: process.pid, line: 'node' }, ...(externalCwd ? [{ pid: EXTERNAL_PID, line: 'vim' }] : [])],
    cwds: [{ pid: process.pid, path: '/' }, ...(externalCwd ? [{ pid: EXTERNAL_PID, path: externalCwd }] : [])],
  });
  vi.spyOn(runningFrom, 'readRunningProcessesAsync').mockImplementation(async () => table());
  vi.spyOn(runningFrom, 'processReader').mockImplementation(() => async () => runningFrom.othersRunningAsync(table()));
  vi.spyOn(listeners, 'readListeningPorts').mockImplementation(async () => new Set(listening));
  const real = getExecutor();
  setExecutor({
    ...real,
    findExecutable: (name, options) => (name === 'my-db' ? '/bin/my-db' : real.findExecutable(name, options)),
    runFileQuietAsync: async (file, args, opts) =>
      file === 'ps' && args.includes('pid=,ppid=')
        ? `${process.pid} 1\n${externalCwd ? `${EXTERNAL_PID} 1\n` : ''}`
        : real.runFileQuietAsync(file, args, opts),
    runFileAsync: async (file, args, opts) => {
      if (file === '/bin/my-db') {
        runs.push([...args, String(opts.env?.DB_PORT)]);
        listening.clear();
        return 'Stopped.';
      }
      return file === 'lsof' || file === 'ps' ? '' : real.runFileAsync(file, args, opts);
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetExecutor();
  rmSync(base, { recursive: true, force: true });
});

function register(record: ProjectRecord = {}, lastUsedMinutesAgo = 30) {
  upsertProject(root, { ports: { db: 8900 }, ...record });
  ensureWorkspaceStorage(root);
  updateWorkspaceState(root, (state) => ({
    ...state,
    services: {
      db: {
        kind: 'commands',
        cwd: root,
        env: { DB_PORT: '8900' },
        ports: { db: 8900 },
        start: ['my-db', 'start'],
        stop: ['my-db', 'stop'],
        state: 'running',
        at: new Date(Date.now() - DAY_MS).toISOString(),
      },
    },
  }));
  age(root, new Date(Date.now() - 3 * DAY_MS));
  recordWorkspaceUse(root, new Date(Date.now() - lastUsedMinutesAgo * MINUTE_MS));
}

const pass = () => runServiceStopPass({ config: loadConfig(), act: true, log: () => {}, operation: testContext() });

describe.skipIf(process.platform === 'win32')(
  'the idle pass for workspace services (skipped on win32, where Stim cannot list the running processes)',
  () => {
    test('a workspace idle past idle.minutes gets its running service stopped once, with its env, its ports kept, and marked for revive', async () => {
      register();
      await pass();
      await pass();
      expect(runs).toEqual([['stop', '8900']]);
      expect(getProject(root)?.ports).toEqual({ db: 8900 });
      expect(serviceRecords(root).db).toMatchObject({ state: 'stopped', stoppedBy: 'idle' });
    });

    test("the service's own process working in its checkout does not keep the workspace active", async () => {
      register();
      externalCwd = root;
      vi.spyOn(services, 'serviceProcessPids').mockResolvedValue(new Set([EXTERNAL_PID]));
      await pass();
      expect(runs).toEqual([['stop', '8900']]);
    });

    test.each<[string, () => void]>([
      ['a Stim command ran within idle.minutes', () => register({}, 5)],
      [
        'a process works in its checkout',
        () => {
          register();
          externalCwd = root;
        },
      ],
      ['maintenance.keep pins it', () => register({ settings: { maintenance: { keep: true } } })],
      ['idle.minutes is 0', () => register({ settings: { idle: { minutes: 0 } } })],
      [
        'nothing listens on its ports',
        () => {
          register();
          listening.clear();
        },
      ],
    ])('nothing runs when %s', async (_name, arrange) => {
      arrange();
      await pass();
      expect(runs).toEqual([]);
      expect(serviceRecords(root).db?.stoppedBy).toBeUndefined();
    });
  },
);
