import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gcMarkFile, readGcMark, type Config } from '@stim-cli/core/state';
import { outputMark, outputMarks, refreshCargoHolderMarks } from '../daemon/marks.ts';
import { readMarkHealth } from '../daemon/mark-health.ts';
import { refreshKnownMarks } from '../daemon/mark-refresh.ts';
import { saveConfig } from '../workspace/config.ts';
import * as discovery from '../workspace/discovery.ts';
import * as artifacts from '../stimd/passes/artifacts.ts';
import { planCargoTargetsAtPressure, trimCargoTargetAction } from '../stimd/passes/cargo-target.ts';
import { resolveMaintenanceSettings } from '../stimd/passes/settings.ts';
import { withCargoLocks } from '../workspace/cargo-lock.ts';
import { testContext } from './_context.ts';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readdirSync: vi.fn<typeof fs.readdirSync>(fs.readdirSync) };
});
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, readdir: vi.fn<typeof fs.readdir>(fs.readdir) };
});

let base: string;
let holder: string;
let app: string;
let target: string;
let config: Config;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', holder, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', ...args], {
    timeout: 10_000,
  });
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-discovered-cargo-')));
  holder = join(base, 'holder');
  app = join(holder, 'apps', 'mobile');
  target = join(holder, 'target');
  mkdirSync(app, { recursive: true });
  mkdirSync(join(holder, 'android', 'app', 'build'), { recursive: true });
  mkdirSync(join(target, 'debug', '.fingerprint'), { recursive: true });
  mkdirSync(join(target, 'debug', 'incremental'), { recursive: true });
  writeFileSync(join(holder, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
  writeFileSync(join(holder, 'Cargo.toml'), '[workspace]\n');
  writeFileSync(join(holder, '.gitignore'), 'target/\nandroid/app/build/\n');
  writeFileSync(join(holder, 'android', 'app', 'build', 'unrelated'), 'keep');
  writeFileSync(join(target, '.rustc_info.json'), '{}');
  writeFileSync(join(target, 'debug', '.cargo-lock'), '');
  writeFileSync(join(target, 'debug', 'incremental', 'artifact'), 'cargo');
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const old = new Date(Date.now() - 3 * 86_400_000);
  for (const path of [
    join(target, 'debug', 'incremental', 'artifact'),
    join(target, 'debug', 'incremental'),
    join(target, 'debug', '.cargo-lock'),
    join(target, 'debug', '.fingerprint'),
    join(target, 'debug'),
  ])
    utimesSync(path, old, old);
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  config = {
    projects: {},
    repos: {},
    maintenance: { autoDiscover: false, discoverRoots: [join(holder, 'apps')], cargoTargetMaxGb: 1 },
  };
  saveConfig(config);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});
async function refresh() {
  await refreshCargoHolderMarks(config, { devices: [], simsFailed: false, operation: testContext() }, undefined, false);
  const saved = readGcMark(holder);
  if (!saved) throw new Error('normal Cargo refresh did not mark its holder');
  return saved;
}
async function plan(pinned = false) {
  return planCargoTargetsAtPressure({
    settings: resolveMaintenanceSettings(config),
    pinned: () => pinned,
    now: Date.now(),
    level: 'critical',
    operation: testContext(),
  });
}

test('a discovered nested app authorizes only its exact holder Cargo candidates in batch and selected-root reads', async () => {
  const saved = await refresh();
  expect(saved.cargoVia).toEqual([app]);
  expect(saved.candidates.some(({ kind }) => kind === 'outputs')).toBe(true);
  saved.dependencies = { markedAt: saved.markedAt, role: 'source', keys: [holder], candidates: [] };
  writeFileSync(gcMarkFile(holder), JSON.stringify(saved));
  const full = vi.spyOn(discovery, 'discoverCheckouts');
  const scan = vi.spyOn(artifacts, 'appRoots');
  vi.mocked(readdir).mockClear();
  vi.mocked(readdirSync).mockClear();
  for (const mark of [(await outputMarks(config, testContext()))[0], await outputMark(config, holder, testContext())]) {
    expect(mark?.candidates).toEqual([expect.objectContaining({ kind: 'cargo-target', path: target })]);
    expect(mark?.dependencies).toBeUndefined();
  }
  expect(readGcMark(holder)).toMatchObject({ cargoVia: [app], dependencies: saved.dependencies });
  expect(full).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
  for (const reader of [vi.mocked(readdir), vi.mocked(readdirSync)])
    expect(reader.mock.calls.map(([path]) => String(path))).not.toContain(join(holder, 'apps'));
  expect(readFileSync(join(holder, 'android', 'app', 'build', 'unrelated'), 'utf8')).toBe('keep');
});

test.each(['route', 'recognition'] as const)('removed %s after marking keeps the saved holder', async (change) => {
  await refresh();
  if (change === 'route') {
    config.maintenance = { autoDiscover: false, discoverRoots: [], cargoTargetMaxGb: 1 };
    saveConfig(config);
  } else writeFileSync(join(app, 'package.json'), '{}');
  expect(await outputMarks(config, testContext())).toEqual([]);
  expect(await outputMark(config, holder, testContext())).toBeNull();
});

test('a newly independent nested Git repository cannot authorize its former holder', async () => {
  await refresh();
  execFileSync('git', ['-C', app, 'init', '-q'], { timeout: 10_000 });
  expect((await discovery.targetedCheckouts(config, [], [app], testContext())).map(({ path }) => path)).toEqual([app]);
  expect(await outputMark(config, holder, testContext())).toBeNull();
});

test.each([undefined, ['relative/path']])(
  'legacy or malformed app hints keep prior registration behavior: %s',
  async (hint) => {
    const saved = await refresh();
    delete saved.cargoVia;
    if (hint) saved.cargoVia = hint;
    writeFileSync(gcMarkFile(holder), JSON.stringify(saved));
    expect(readGcMark(holder)).toBeTruthy();
    expect(readGcMark(holder)).not.toHaveProperty('cargoVia');
    expect(await outputMark(config, holder, testContext())).toBeNull();
    config.projects[app] = {};
    saveConfig(config);
    expect(
      (await outputMark(config, holder, testContext()))?.candidates.every(({ kind }) => kind === 'cargo-target'),
    ).toBe(true);
  },
);

test('pins, protected active roots and a route removed after planning keep target contents intact', async () => {
  await refresh();
  expect((await plan(true)).actions).toEqual([]);
  const [action] = (await plan()).actions;
  if (!action) throw new Error('authorized Cargo mark did not plan');
  expect(await trimCargoTargetAction(action, testContext(), false, undefined, holder)).toMatchObject({
    status: 'kept',
  });
  config.maintenance = { autoDiscover: false, discoverRoots: [], cargoTargetMaxGb: 1 };
  saveConfig(config);
  expect(await trimCargoTargetAction(action, testContext())).toMatchObject({ status: 'kept' });
  expect(readFileSync(join(target, 'debug', 'incremental', 'artifact'), 'utf8')).toBe('cargo');
});

test.skipIf(process.platform === 'win32')(
  'a live Cargo build lock still keeps the newly authorized holder target',
  async () => {
    await refresh();
    const [action] = (await plan()).actions;
    if (!action) throw new Error('authorized Cargo mark did not plan');
    const result = await withCargoLocks([join(target, 'debug', '.cargo-lock')], () =>
      trimCargoTargetAction(action, testContext()),
    );
    expect(result).toMatchObject({
      value: { status: 'kept', detail: expect.stringMatching(/a build holds|a process uses/) },
    });
    expect(readFileSync(join(target, 'debug', 'incremental', 'artifact'), 'utf8')).toBe('cargo');
  },
);

test('discovered app authority excludes a Rust submodule and rechecks a newly independent package', async () => {
  const native = join(holder, 'packages', 'native');
  const nativeTarget = join(native, 'target');
  mkdirSync(join(nativeTarget, 'debug', 'incremental'), { recursive: true });
  mkdirSync(join(nativeTarget, 'debug', '.fingerprint'));
  writeFileSync(join(native, 'Cargo.toml'), '[package]\nname="native"\nversion="0.1.0"\n');
  writeFileSync(join(native, '.gitignore'), 'target/\n');
  writeFileSync(join(nativeTarget, '.rustc_info.json'), '{}');
  writeFileSync(join(nativeTarget, 'debug', '.cargo-lock'), '');
  writeFileSync(join(nativeTarget, 'debug', 'incremental', 'artifact'), 'independent');
  git('add', 'packages/native/Cargo.toml', 'packages/native/.gitignore');
  git('commit', '-qm', 'native package');
  const old = new Date(Date.now() - 3 * 86_400_000);
  for (const path of [
    join(nativeTarget, 'debug', 'incremental', 'artifact'),
    join(nativeTarget, 'debug', 'incremental'),
    join(nativeTarget, 'debug', '.cargo-lock'),
    join(nativeTarget, 'debug', '.fingerprint'),
    join(nativeTarget, 'debug'),
  ])
    utimesSync(path, old, old);
  await refresh();
  const before = await plan();
  const action = before.actions.find(({ target: path }) => path === nativeTarget);
  if (!action) throw new Error('holder-owned nested Cargo package was not eligible');
  execFileSync('git', ['-C', native, 'init', '-q'], { timeout: 10_000 });
  execFileSync('git', ['-C', native, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'add', '.'], {
    timeout: 10_000,
  });
  execFileSync(
    'git',
    ['-C', native, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'independent'],
    { timeout: 10_000 },
  );
  git('rm', '--cached', '-r', 'packages/native');
  git('add', 'packages/native');
  writeFileSync(
    join(holder, '.gitmodules'),
    '[submodule "packages/native"]\npath = packages/native\nurl = ./packages/native\n',
  );
  git('add', '.gitmodules');
  git('commit', '-qm', 'native submodule');
  git('submodule', 'absorbgitdirs', 'packages/native');
  expect(readFileSync(join(native, '.git'), 'utf8')).toMatch(/^gitdir:/);
  expect(git('ls-files', '--stage', 'packages/native').toString()).toContain('160000');
  expect(readGcMark(holder)?.candidates.map(({ path }) => path)).toContain(nativeTarget);
  expect((await plan()).actions.map(({ target: path }) => path)).toContain(target);
  expect((await plan()).actions.map(({ target: path }) => path)).not.toContain(nativeTarget);
  expect(await trimCargoTargetAction(action, testContext())).toMatchObject({ status: 'kept' });
  expect(readFileSync(join(nativeTarget, 'debug', 'incremental', 'artifact'), 'utf8')).toBe('independent');
});

test('a bounded holder refresh preserves custom nested Cargo candidates, provenance and independent dependency generation', async () => {
  const custom = join(holder, 'tools', 'engine');
  const customTarget = join(custom, 'target');
  mkdirSync(customTarget, { recursive: true });
  writeFileSync(join(custom, 'Cargo.toml'), '[package]\nname="engine"\nversion="0.1.0"\n');
  writeFileSync(join(customTarget, '.rustc_info.json'), '{}');
  config.projects[custom] = {};
  saveConfig(config);
  const saved = await refresh();
  expect(saved.candidates).toContainEqual(expect.objectContaining({ path: customTarget, kind: 'cargo-target' }));
  const dependencies = {
    markedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    role: 'source' as const,
    keys: [custom],
    candidates: [],
  };
  const dirtyAt = new Date(Date.now() - 5 * 60_000).toISOString();
  writeFileSync(
    gcMarkFile(holder),
    JSON.stringify({
      ...saved,
      markedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      lastActivityAt: new Date().toISOString(),
      dependencies,
      dirtyAt,
    }),
  );
  const history = await readMarkHealth(config, testContext());
  expect(history.holders).toContainEqual(
    expect.objectContaining({ root: holder, roots: expect.arrayContaining([custom]) }),
  );
  const full = vi.spyOn(discovery, 'discoverCheckouts');
  await refreshKnownMarks(
    {
      config,
      known: history.roots?.map(({ root }) => root) ?? [],
      holders: history.holders,
      at: Date.now(),
      intervalMs: 60_000,
      devices: [],
      simsFailed: false,
    },
    testContext(),
  );
  expect(readGcMark(holder)).toMatchObject({ dependencies, dirtyAt, cargoVia: saved.cargoVia });
  expect(readGcMark(holder)?.markedAt).toBe(new Date().toISOString());
  expect(readGcMark(holder)?.candidates).toContainEqual(
    expect.objectContaining({ path: customTarget, kind: 'cargo-target' }),
  );
  expect(full).not.toHaveBeenCalled();
});
