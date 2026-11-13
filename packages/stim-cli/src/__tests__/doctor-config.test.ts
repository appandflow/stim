import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import { checkMachineSettings, readMachineSettings } from '../diagnostics/doctor-config.ts';
import {
  reactNativeDoctorFindings,
  type DoctorInspectionOptions,
  runDoctor as inspectDoctor,
} from '../diagnostics/doctor.ts';
import { resolveOptimizations } from '../optimizations.ts';

import type { SettingsObject } from '@stim-cli/core/state';
import { writeCasToolchain } from './_factories.ts';

vi.mock('../engine/ios-signing.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine/ios-signing.ts')>()),
  probeSigningIdentities: async () => [{ sha1: 'A'.repeat(40), name: 'Apple Development: Doctor Test (TEAMID5678)' }],
}));

async function runDoctor(root: string, options: DoctorInspectionOptions = {}) {
  return (await inspectDoctor(root, options, [reactNativeDoctorFindings])).findings;
}

const MACHINE = '/home/.stim/config.json';

function check(settings: SettingsObject, present: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return checkMachineSettings({
    settings,
    layers: [{ scope: 'machine', file: MACHINE, settings }],
    projectRoot: '/app',
    optimizations: resolveOptimizations(settings, env),
    exists: (path) => present.includes(path),
    env,
  });
}

test('a removed name in the config or the environment is an inert key, with no replacement named', () => {
  expect(check({ remote: { buildMode: 'force' }, budget: { minFreeDiskGb: 12 } })).toEqual([
    expect.objectContaining({ title: 'A key in the config is inert', fix: `Remove remote.buildMode from ${MACHINE}.` }),
    expect.objectContaining({
      title: 'A key in the config is inert',
      fix: `Remove budget.minFreeDiskGb from ${MACHINE}.`,
    }),
  ]);
  expect(check({}, [], { STIM_REMOTE_BUILD_MODE: 'force' })).toEqual([]);
});

test('STIM_MAINTENANCE in the environment is reported with daemon.mode and STIM_DAEMON', () => {
  expect(check({}, [], { STIM_MAINTENANCE: 'off' })).toEqual([
    expect.objectContaining({
      title: 'STIM_MAINTENANCE was replaced by daemon.mode',
      fix: 'Run `stim settings set daemon.mode off` or set STIM_DAEMON, then unset STIM_MAINTENANCE.',
    }),
  ]);
});

test.each([
  [
    'maintenance.mode off in the machine config',
    'machine' as const,
    { maintenance: { mode: 'off' } },
    'Run `stim settings set daemon.mode off`, then `stim settings unset maintenance.mode`.',
  ],
  [
    'metro.idleStopMinutes 0 in .stim.json',
    'committed' as const,
    { metro: { idleStopMinutes: 0 } },
    'Run `stim settings set idle.minutes 0 --scope committed`, then `stim settings unset metro.idleStopMinutes`.',
  ],
])('%s costs: the commands that act refuse while it is there', (_, scope, settings, fix) => {
  const findings = checkMachineSettings({
    settings,
    layers: [{ scope, file: MACHINE, settings }],
    projectRoot: '/app',
    exists: () => false,
    env: {},
  });
  expect(findings).toEqual([expect.objectContaining({ level: 'cost', fix })]);
});

test('an old value that turned nothing off, or sits in a layer it was never read from, stays a note', () => {
  expect(check({ maintenance: { mode: 'on' } })).toEqual([expect.objectContaining({ level: 'note' })]);
  expect(check({ metro: { idleStopMinutes: 0 } })).toEqual([expect.objectContaining({ level: 'note' })]);
});

test('maintenance.idleStopHours 0 costs until idle.dormantDays is set, naming the three ways out, and never refuses', () => {
  const settings = { maintenance: { idleStopHours: 0 } };
  const [finding] = check(settings);
  expect(finding).toMatchObject({ level: 'cost', detail: expect.not.stringContaining('refuse') });
  for (const command of [
    'stim settings set idle.dormantDays 0',
    'stim settings set idle.dormantDays 1',
    'stim settings unset maintenance.idleStopHours --scope machine',
  ])
    expect(finding?.fix).toContain(`\`${command}\``);
  expect(
    checkMachineSettings({
      settings,
      layers: [{ scope: 'machine', file: MACHINE, settings }],
      projectRoot: '/app',
      exists: () => false,
      env: {},
      machineConfig: { ...settings, idle: { dormantDays: 0 } },
    }),
  ).toEqual([]);
});

test('a leftover whose replacement a layer already sets names that value and asks only for the unset', () => {
  const committed = { metro: { idleStopMinutes: 0 } };
  const machine = { idle: { minutes: 0 } };
  const findings = checkMachineSettings({
    settings: { ...committed, ...machine },
    layers: [
      { scope: 'committed', file: '/app/.stim.json', settings: committed },
      { scope: 'machine', file: MACHINE, settings: machine },
    ],
    projectRoot: '/app',
    exists: () => false,
    env: {},
  });
  expect(findings).toEqual([
    expect.objectContaining({
      level: 'cost',
      detail: expect.stringContaining(`idle.minutes is 0 in ${MACHINE}.`),
      fix: 'Run `stim settings unset metro.idleStopMinutes`.',
    }),
  ]);
});

describe('against a config file on disk', () => {
  let home: string;
  let project: string;
  let savedToolchain: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-doctor-config-home-'));
    project = mkdtempSync(join(tmpdir(), 'stim-doctor-config-project-'));
    process.env.STIM_HOME = home;
    savedToolchain = process.env.STIM_ANDROID_CAS_TOOLCHAIN;
    delete process.env.STIM_ANDROID_CAS_TOOLCHAIN;
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }));
    mkdirSync(join(project, 'node_modules'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.STIM_HOME;
    if (savedToolchain === undefined) delete process.env.STIM_ANDROID_CAS_TOOLCHAIN;
    else process.env.STIM_ANDROID_CAS_TOOLCHAIN = savedToolchain;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  function writeConfig(config: Record<string, unknown>) {
    writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  }

  test.each(['STIM_MAX_BUILDS', 'STIM_MAX_IOS_DEVICES'])(
    'doctor reports invalid %s instead of rejecting',
    async (variable) => {
      vi.stubEnv(variable, 'bogus');
      const findings = await runDoctor(project);
      expect(findings).toContainEqual(
        expect.objectContaining({
          level: 'cost',
          detail: `Invalid ${variable} value "bogus". Expected a whole number, 0 or more.`,
          fix: expect.stringContaining('unset the environment variable'),
        }),
      );
    },
  );

  test('a remote.build hand-edited into the machine config to an invalid value reaches doctor', async () => {
    writeConfig({ version: 2, repos: {}, projects: {}, remote: { build: 'bad word' } });
    const wrongType = (await runDoctor(project)).filter((found) => found.title === 'A setting has the wrong type');
    expect(wrongType).toEqual([
      expect.objectContaining({
        level: 'cost',
        detail:
          'Invalid remote.build setting "bad word". Expected local, auto, remote, remote-only, or a tailnet machine name.',
      }),
    ]);
  });

  test('an unparseable config reports the repair line instead of crashing doctor', async () => {
    writeFileSync(join(home, 'config.json'), '{ "projects": ');
    const machine = readMachineSettings({ projectPath: project, gitCommonDir: null, repoRoot: project });
    assert(machine.corrupt);
    expect(machine.corrupt.title).toBe('The Stim config is not a valid JSON object');
    expect(machine.corrupt.detail).toContain(join(home, 'config.json'));
    expect(machine.corrupt.fix).toBe(
      `Repair the file, or move it aside to start over: mv "${join(home, 'config.json')}" "${join(home, 'config.json')}.broken"`,
    );
    expect(await runDoctor(project)).toEqual([machine.corrupt]);
  });

  test('doctor reports a toolchain the environment names but does not supply', async () => {
    writeConfig({ version: 2, repos: {}, projects: {} });
    const missing = join(home, 'gone', 'toolchain.json');
    process.env.STIM_ANDROID_CAS_TOOLCHAIN = missing;
    const findings = (await runDoctor(project)).filter((found) => found.detail.includes('STIM_ANDROID_CAS_TOOLCHAIN'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      level: 'note',
      title: 'An environment variable points at a path that is not there',
    });
    expect(findings[0]?.detail).toBe(
      `STIM_ANDROID_CAS_TOOLCHAIN in the environment names ${missing}, which does not exist.`,
    );
  });

  test('doctor reports a dead machine path on every platform, not only the native one', async () => {
    writeConfig({
      version: 2,
      repos: {},
      projects: {},
      optimizations: { android: { compilerCache: 'cas', casToolchain: join(home, 'gone', 'toolchain.json') } },
    });
    for (const platform of [undefined, 'ios', 'android'] as const) {
      const findings = (await runDoctor(project, { platform })).filter((found) =>
        found.detail.includes('optimizations.android.casToolchain'),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.level).toBe('note');
    }
  });

  test('a manifest that is there but cannot be used is reported in the words the build warns with', async () => {
    const manifest = join(home, 'toolchain.json');
    writeFileSync(manifest, '{}');
    writeConfig({
      version: 2,
      repos: {},
      projects: {},
      optimizations: { android: { compilerCache: 'cas', casToolchain: manifest } },
    });
    const findings = (await runDoctor(project)).filter((found) =>
      found.detail.includes('optimizations.android.casToolchain'),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: 'note', title: 'A setting holds a value Stim cannot use' });
    expect(findings[0]?.detail).toBe(
      `optimizations.android.casToolchain in ${join(home, 'config.json')} could not be used: ${manifest} declares ` +
        'no clang, clangxx, lld, ar, ranlib, ndk, resourceDir. Android builds fall back to ccache when it is ' +
        'available.',
    );
    expect(findings[0]?.fix).toBe(
      `Repair ${manifest}, or remove optimizations.android.casToolchain from ${join(home, 'config.json')}.`,
    );
  });

  test('the ccache checks follow the backend a dead CAS toolchain leaves the build with', async () => {
    const usable = writeCasToolchain(join(home, 'cas')).manifest;
    const options = { lookupCcache: () => false, platform: 'android' as const };
    const ccacheReported = async (casToolchain: string) => {
      writeConfig({
        version: 2,
        repos: {},
        projects: {},
        optimizations: { android: { compilerCache: 'cas', casToolchain } },
      });
      return (await runDoctor(project, options)).some((found) => /ccache is not on PATH/.test(found.title));
    };
    expect(await ccacheReported(usable)).toBe(false);
    expect(await ccacheReported(join(home, 'gone', 'toolchain.json'))).toBe(true);
  });

  test('a compilerCache Stim cannot resolve is one finding that invents no toolchain path', async () => {
    writeConfig({
      version: 2,
      repos: {},
      projects: {},
      optimizations: { android: { compilerCache: 'CAS', casToolchain: 'tc/toolchain.json' } },
    });
    const reported = await runDoctor(project);
    const findings = reported.filter(
      (found) => found.detail.includes('compilerCache') || found.detail.includes('casToolchain'),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: 'cost', title: 'A setting has the wrong type' });
    expect(findings[0]?.detail).toBe(
      'Invalid optimizations.android.compilerCache setting "CAS". Expected one of: auto, ccache, cas, none.',
    );
    expect(reported.some((found) => found.detail.includes(join(project, 'tc')))).toBe(false);
  });
});
