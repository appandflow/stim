import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskUsageCacheFile, type DaemonLadderAction } from '@stim-cli/core/state';
import { writeCacheFile } from '../cache-file.ts';
import { REAL_BYTES_THRESHOLD } from '../daemon/dependencies.ts';
import { treeSignature } from '../private-size.ts';
import { createMaintenanceLane, runDormantReduction, type HomePasses } from '../daemon/passes.ts';
import * as measure from '../daemon/measure.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import * as maintenanceRun from '../stimd/passes/run.ts';
import { loadConfig, saveConfig, upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceDir } from '../workspace/paths.ts';
import { recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';
import * as fsUtil from '../fs-util.ts';
import { metroStoreRoot } from '../stimd/metro/metro-store.ts';
import * as runningFrom from '../workspace/running-from.ts';
import type { RunningProcesses } from '../workspace/running-from.ts';
import { testContext } from './_context.ts';

const DAY_MS = 86_400_000;
const BUILD = join('android', 'app', 'build');
const EXTERNAL_PID = 4242;

let base: string;
let externalCwd: string | null;
let processesListed: boolean;
let heldLock: string | null;

const measured: HomePasses['measured'] = {
  measurement: {
    disk: [{ volume: '/', freeMb: 500_000 }],
    memory: { level: 'normal', availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
    load1: 0,
    cores: 8,
    bootedSimulators: 0,
    runningEmulators: null,
    interaction: null,
  },
  sims: [],
  simsError: null,
  devices: [],
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-dormant-outputs-')));
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  vi.stubEnv('HOME', join(base, 'user'));
  mkdirSync(join(base, 'user'), { recursive: true });
  saveConfig({ version: 2, projects: {}, repos: {} });
  externalCwd = null;
  processesListed = true;
  heldLock = null;
  const table = (): RunningProcesses | null => {
    if (!processesListed) return null;
    const external = externalCwd === null ? [] : [{ pid: EXTERNAL_PID, line: 'java GradleDaemon' }];
    return {
      commands: [{ pid: process.pid, line: 'node' }, ...external],
      cwds: [
        { pid: process.pid, path: '/' },
        ...(externalCwd === null ? [] : [{ pid: EXTERNAL_PID, path: externalCwd }]),
      ],
    };
  };
  vi.spyOn(runningFrom, 'readRunningProcessesAsync').mockImplementation(async () => table());
  vi.spyOn(runningFrom, 'processReader').mockImplementation(() => async () => runningFrom.othersRunningAsync(table()));
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileQuietAsync: async (file, args, opts) =>
      file === 'ps' && args.includes('pid=,ppid=')
        ? `${process.pid} 1\n${externalCwd === null ? '' : `${EXTERNAL_PID} 1\n`}`
        : real.runFileQuietAsync(file, args, opts),
    runFileAsync: async (file, args, opts) => {
      if (file === 'lsof' && heldLock !== null && args.includes(heldLock)) return `${EXTERNAL_PID}\n`;
      return file === 'lsof' || file === 'ps' ? '' : real.runFileAsync(file, args, opts);
    },
  });
  vi.spyOn(maintenanceRun, 'runMaintenance').mockResolvedValue(undefined);
  vi.spyOn(measure, 'measureTick').mockResolvedValue(measured);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetExecutor();
  rmSync(base, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const when = new Date(Date.now() - 3 * DAY_MS).toISOString();
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
};

function repo(name: string): string {
  const root = join(base, name);
  mkdirSync(join(root, BUILD), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, '.gitignore'), 'build/\ntarget/\nnode_modules/\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  writeFileSync(join(root, BUILD, 'app.apk'), 'artifact');
  return root;
}

function register(root: string): string {
  upsertProject(root, {});
  ensureWorkspaceStorage(root);
  mkdirSync(join(workspaceDir(root), 'derived-data'), { recursive: true });
  writeFileSync(join(workspaceDir(root), 'derived-data', 'build.db'), 'x');
  return root;
}

function cargo(name: string, kind: 'exact' | 'tagged' | 'untagged'): string {
  const root = repo(name);
  const target = join(root, 'target');
  mkdirSync(join(target, 'debug', '.fingerprint'), { recursive: true });
  writeFileSync(join(target, 'debug', '.fingerprint', 'unit'), 'x');
  writeFileSync(join(target, 'debug', '.cargo-lock'), '');
  mkdirSync(join(target, 'doc'));
  writeFileSync(join(target, 'doc', 'index.html'), 'x');
  if (kind === 'exact') writeFileSync(join(root, 'exact.mjs'), '');
  if (kind === 'tagged') writeFileSync(join(target, 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
  if (kind === 'untagged') {
    writeFileSync(join(root, 'Cargo.toml'), '');
    writeFileSync(join(target, '.rustc_info.json'), '{}');
  }
  return register(root);
}

function onlyTarget(root: string): string {
  rmSync(join(root, 'android'), { recursive: true });
  rmSync(join(workspaceDir(root), 'derived-data'), { recursive: true });
  return root;
}

function age(path: string, when: Date) {
  if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) age(join(path, name), when);
  utimesSync(path, when, when);
}

function idleFor(days: number, ...roots: string[]) {
  age(base, new Date(Date.now() - 3 * DAY_MS));
  for (const root of roots) recordWorkspaceUse(root, new Date(Date.now() - days * DAY_MS));
}

async function hourlyStep(act: boolean): Promise<DaemonLadderAction[]> {
  const lane = createMaintenanceLane(() => {}, { run: async () => {} }, new BigInt64Array(1));
  lane.start(
    {
      config: loadConfig(),
      measured,
      operation: testContext(),
      workspaces: [],
      pressure: { level: 'normal', disk: 'normal', memory: 'normal', reasons: [], memoryWarningSince: null },
    },
    act,
  );
  await lane.settled();
  return lane.take().filter((action) => action.kind === 'delete-build-outputs');
}

const gc = async (act = true) =>
  (await runDormantReduction({ act, trigger: 'gc', operation: testContext() })).filter(
    (action) => action.kind === 'delete-build-outputs',
  );

describe.skipIf(process.platform === 'win32')(
  'the dormant build-output step (skipped on win32, where Stim cannot list the running processes)',
  () => {
    test("the daemon's hourly step deletes the build outputs of a registered workspace idle a day at normal pressure, and its own deletions do not keep the next step", async () => {
      saveConfig({ version: 2, projects: {}, repos: {}, idle: { sourceDormantDays: 1 } });
      const root = register(repo('app'));
      mkdirSync(join(root, 'android', 'build'));
      mkdirSync(join(metroStoreRoot(root), 'shared'), { recursive: true });
      mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'x');
      idleFor(3, root);
      const modules = join(root, 'node_modules');
      writeCacheFile(diskUsageCacheFile(modules), {
        path: modules,
        measuredAt: new Date().toISOString(),
        bytes: 2 * REAL_BYTES_THRESHOLD,
        privateBytes: 2 * REAL_BYTES_THRESHOLD,
        signature: treeSignature(modules),
      });

      const actions = await hourlyStep(true);

      expect(actions).toEqual([expect.objectContaining({ target: root, outcome: 'done' })]);
      expect(existsSync(join(root, BUILD))).toBe(false);
      expect(existsSync(join(root, 'android', 'build'))).toBe(false);
      expect(existsSync(join(workspaceDir(root), 'derived-data'))).toBe(false);
      expect(existsSync(join(root, 'node_modules'))).toBe(false);
      expect(existsSync(join(root, 'package.json'))).toBe(true);
      expect(existsSync(join(metroStoreRoot(root), 'shared'))).toBe(true);
    });

    test('a Gradle build working in the checkout keeps its outputs, whatever Stim last saw', async () => {
      const root = register(repo('app'));
      idleFor(3, root);
      externalCwd = join(root, 'android');

      expect(await gc()).toEqual([
        expect.objectContaining({ outcome: 'kept', detail: expect.stringContaining(`process ${EXTERNAL_PID}`) }),
      ]);
      expect(existsSync(join(root, BUILD, 'app.apk'))).toBe(true);
      expect(existsSync(join(workspaceDir(root), 'derived-data'))).toBe(true);
    });

    test('a registered app inside a larger checkout keeps its outputs while a process works at the checkout root', async () => {
      const root = repo('mono');
      const app = join(root, 'apps', 'mobile');
      mkdirSync(join(app, BUILD), { recursive: true });
      writeFileSync(join(app, BUILD, 'app.apk'), 'artifact');
      register(app);
      idleFor(3, app);
      externalCwd = root;

      expect(await gc()).toEqual([
        expect.objectContaining({
          target: app,
          outcome: 'kept',
          detail: expect.stringContaining(`process ${EXTERNAL_PID}`),
        }),
      ]);
      expect(existsSync(join(app, BUILD, 'app.apk'))).toBe(true);
    });

    test('where the running processes cannot be listed, as on Windows, gc keeps the outputs and says why', async () => {
      const root = register(repo('app'));
      idleFor(3, root);
      processesListed = false;

      expect(await gc()).toEqual([
        expect.objectContaining({ outcome: 'kept', detail: expect.stringContaining('cannot be listed') }),
      ]);
      expect(existsSync(join(root, BUILD, 'app.apk'))).toBe(true);
    });

    test('a workspace in use is not measured, and report mode predicts nothing for it', async () => {
      const root = register(repo('app'));
      idleFor(3, root);
      writeWorkspaceState(root, { macos: {} });
      const walks = vi.spyOn(fsUtil, 'measuredDirectorySizeAsync');

      expect(await hourlyStep(false)).toEqual([]);
      expect(await gc()).toEqual([]);
      expect(walks).not.toHaveBeenCalled();
      expect(existsSync(join(root, BUILD, 'app.apk'))).toBe(true);
    });

    test('a worktree locked with git worktree lock keeps its outputs', async () => {
      const main = repo('main');
      const linked = join(base, 'linked');
      git(main, 'worktree', 'add', '-q', '-b', 'feature', linked);
      mkdirSync(join(linked, BUILD), { recursive: true });
      writeFileSync(join(linked, BUILD, 'app.apk'), 'artifact');
      git(main, 'worktree', 'lock', linked);
      register(linked);
      idleFor(3, linked);

      expect(await gc()).toEqual([
        expect.objectContaining({ target: linked, outcome: 'kept', detail: 'locked with git worktree lock' }),
      ]);
      expect(existsSync(join(linked, BUILD, 'app.apk'))).toBe(true);
    });

    test.each(['exact', 'tagged', 'untagged'] as const)(
      'an idle %s Cargo target/ that is the only output is predicted, then deleted whole',
      async (kind) => {
        const root = onlyTarget(cargo('app', kind));
        idleFor(3, root);

        expect(await hourlyStep(false)).toEqual([
          expect.objectContaining({ target: root, outcome: 'would', bytes: expect.any(Number) }),
        ]);
        expect(existsSync(join(root, 'target', 'debug'))).toBe(true);
        expect(await gc()).toEqual([expect.objectContaining({ target: root, outcome: 'done' })]);
        expect(existsSync(join(root, 'target'))).toBe(false);
      },
    );

    test('a dry run names the entries of an idle target that are not build output, and gc keeps exactly those', async () => {
      const root = onlyTarget(cargo('app', 'untagged'));
      mkdirSync(join(root, 'target', 'criterion'));
      writeFileSync(join(root, 'target', 'criterion', 'estimates.json'), '{}');
      idleFor(3, root);

      expect(await gc(false)).toEqual([
        expect.objectContaining({
          target: root,
          outcome: 'would',
          detail: expect.stringContaining('not recognised as build output: criterion'),
        }),
      ]);
      expect(await gc()).toEqual([expect.objectContaining({ target: root, outcome: 'done' })]);
      expect(readdirSync(join(root, 'target'))).toEqual(['criterion']);
    });

    test.each([
      [
        'a build wrote a profile in that time',
        (target: string) => utimesSync(join(target, 'debug'), new Date(), new Date()),
        'was written in that time',
        'kept',
      ],
      [
        'a build holds a profile lock',
        (target: string) => {
          heldLock = join(target, 'debug', '.cargo-lock');
        },
        'a build holds',
        'would',
      ],
      [
        'a trim left a directory marked not restored',
        (target: string) => {
          mkdirSync(join(target, '.stim-trimmed', '0'), { recursive: true });
          writeFileSync(join(target, '.stim-trimmed', 'NOT-RESTORED'), '');
        },
        'could not put back',
        'kept',
      ],
      [
        'a trim moved a directory aside for a person',
        (target: string) => mkdirSync(join(target, '.stim-not-restored-1-0')),
        'could not put back',
        'kept',
      ],
    ])('an idle untagged Cargo target/ stays whole, and gc says why, when %s', async (_, arrange, why, report) => {
      const root = onlyTarget(cargo('app', 'untagged'));
      idleFor(3, root);
      arrange(join(root, 'target'));
      expect(await gc(false)).toEqual([expect.objectContaining({ target: root, outcome: report })]);
      expect(await gc()).toEqual([
        expect.objectContaining({
          target: root,
          outcome: 'kept',
          detail: expect.stringMatching(new RegExp(`${join(root, 'target')}.*${why}`)),
        }),
      ]);
      expect(existsSync(join(root, 'target', 'debug', '.fingerprint', 'unit'))).toBe(true);
    });

    test('a Cargo target/ of a workspace used today stays, and a target/ beside Cargo.toml that Cargo did not write is no output', async () => {
      const used = onlyTarget(cargo('used', 'untagged'));
      const other = onlyTarget(cargo('other', 'untagged'));
      rmSync(join(other, 'target'), { recursive: true });
      mkdirSync(join(other, 'target'));
      writeFileSync(join(other, 'target', '.fingerprint'), 'x');
      idleFor(3, used, other);
      recordWorkspaceUse(used, new Date());

      expect(await gc()).toEqual([]);
      expect(existsSync(join(used, 'target', 'debug', '.fingerprint', 'unit'))).toBe(true);
      expect(existsSync(join(other, 'target', '.fingerprint'))).toBe(true);
    });

    test('report mode predicts the workspace acting mode would reduce, and not the one it would keep', async () => {
      const idle = register(repo('idle'));
      const main = repo('main');
      const locked = join(base, 'locked');
      git(main, 'worktree', 'add', '-q', '-b', 'feature', locked);
      mkdirSync(join(locked, BUILD), { recursive: true });
      git(main, 'worktree', 'lock', locked);
      register(locked);
      idleFor(3, idle, locked);

      expect(await hourlyStep(false)).toEqual([expect.objectContaining({ target: idle, outcome: 'would', bytes: 0 })]);
      expect(existsSync(join(idle, BUILD))).toBe(true);
    });

    test('a workspace whose outputs cannot be deleted is reported failed and the next one is still reduced', async () => {
      const stuck = register(repo('stuck'));
      const free = register(repo('free'));
      const sealed = join(stuck, BUILD, 'sealed');
      mkdirSync(sealed);
      writeFileSync(join(sealed, 'unit'), 'x');
      idleFor(5, stuck);
      recordWorkspaceUse(free, new Date(Date.now() - 3 * DAY_MS));
      chmodSync(sealed, 0o555);

      const actions = await hourlyStep(true).finally(() => chmodSync(sealed, 0o755));
      expect(actions).toEqual([
        expect.objectContaining({ target: stuck, outcome: 'failed', bytes: expect.any(Number) }),
        expect.objectContaining({ target: free, outcome: 'done' }),
      ]);
      expect(actions[0]?.bytes).toBeGreaterThan(0);
      expect(existsSync(join(workspaceDir(stuck), 'derived-data'))).toBe(false);
      expect(existsSync(join(free, BUILD))).toBe(false);
    });
  },
);
