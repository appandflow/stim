import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import { checkMachineSettings, readMachineSettings } from '../doctor-config.ts';
import { runDoctor } from '../doctor.ts';
import { resolveOptimizations } from '../optimizations.ts';
import { mergeSettingsLayers, settingsLayers } from '../settings.ts';
import type { SettingsObject } from '../types.ts';

const MACHINE = '/home/.stim/config.json';

function check(settings: SettingsObject, present: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return checkMachineSettings({
    settings,
    layers: [{ file: MACHINE, settings }],
    projectRoot: '/app',
    optimizations: resolveOptimizations(settings, env),
    exists: (path) => present.includes(path),
    env,
  });
}

test('a path setting that names a file which is not there is reported once, by key', () => {
  const findings = check({ optimizations: { android: { casToolchain: '/gone/toolchain.json' } } });
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ level: 'note', title: 'A setting points at a path that is not there' });
  expect(findings[0]?.detail).toBe(
    `optimizations.android.casToolchain in ${MACHINE} names /gone/toolchain.json, which does not exist.`,
  );
  expect(findings[0]?.fix).toBe(
    `Point optimizations.android.casToolchain at the path it should name, or remove it from ${MACHINE}.`,
  );
});

test('the same path existing reports nothing', () => {
  expect(
    check({ optimizations: { android: { casToolchain: '/there/toolchain.json' } } }, ['/there/toolchain.json']),
  ).toEqual([]);
});

test('a relative path setting is resolved against the project root before the existence test', () => {
  const settings = { ios: { simslimProfile: 'tools/simslim.json' } };
  expect(check(settings, ['/app/tools/simslim.json'])).toEqual([]);
  const findings = check(settings);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.detail).toContain('/app/tools/simslim.json');
});

test('a CAS selection with no toolchain is a finding rather than a refusal mid-build', () => {
  const findings = check({ optimizations: { android: { compilerCache: 'cas' } } });
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    level: 'note',
    title: 'A setting needs a companion this config does not supply',
  });
  expect(findings[0]?.detail).toBe(
    `optimizations.android.compilerCache in ${MACHINE} is "cas", but no optimizations.android.casToolchain or ` +
      'STIM_ANDROID_CAS_TOOLCHAIN names the toolchain manifest. Android builds fall back to ccache when it is ' +
      'available.',
  );
  expect(findings[0]?.fix).toBe(
    'Set optimizations.android.casToolchain to the toolchain JSON manifest, or set ' +
      'optimizations.android.compilerCache to ccache.',
  );
});

test.each([null, 5, true, {}])(
  'a casToolchain of %j is named once in every compiler cache state rather than refusing the build',
  (casToolchain) => {
    for (const compilerCache of ['auto', 'ccache', 'cas', 'none'] as const) {
      const findings = check({ optimizations: { android: { compilerCache, casToolchain } } });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ level: 'note', title: 'A setting holds a value Stim cannot use' });
      expect(findings[0]?.detail).toBe(
        `optimizations.android.casToolchain in ${MACHINE} is ${JSON.stringify(casToolchain)}, which is not an ` +
          'absolute path to a toolchain JSON manifest. ' +
          (compilerCache === 'none'
            ? 'Android builds use no compiler cache, because optimizations.android.compilerCache is "none".'
            : 'Android builds fall back to ccache when it is available.'),
      );
    }
  },
);

test.each(['relative.json', '/abs/toolchain.json\n'])(
  'a casToolchain of %j is one finding that invents no path the resolver never reads',
  (casToolchain) => {
    const findings = check({ optimizations: { android: { casToolchain } } });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe('A setting holds a value Stim cannot use');
    expect(findings[0]?.detail).not.toContain('/app/');
  },
);

test('an unusable toolchain in the environment is fixed by changing the environment, not the config', () => {
  const settings = { optimizations: { android: { casToolchain: '/there/toolchain.json' } } };
  const findings = check(settings, ['/there/toolchain.json'], { STIM_ANDROID_CAS_TOOLCHAIN: 'relative.json' });
  expect(findings).toHaveLength(1);
  expect(findings[0]?.title).toBe('An environment variable holds a value Stim cannot use');
  expect(findings[0]?.detail).toContain('STIM_ANDROID_CAS_TOOLCHAIN in the environment');
  expect(findings[0]?.fix).toBe(
    'Point STIM_ANDROID_CAS_TOOLCHAIN at an absolute path to the toolchain JSON manifest, or unset it.',
  );
});

test('a toolchain the environment names but does not supply is reported against the environment', () => {
  const findings = check({}, [], { STIM_ANDROID_CAS_TOOLCHAIN: '/missing/toolchain.json' });
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    level: 'note',
    title: 'An environment variable points at a path that is not there',
  });
  expect(findings[0]?.detail).toBe(
    'STIM_ANDROID_CAS_TOOLCHAIN in the environment names /missing/toolchain.json, which does not exist.',
  );
  expect(findings[0]?.fix).toBe('Point STIM_ANDROID_CAS_TOOLCHAIN at the path it should name, or unset it.');
});

test('an environment toolchain that is there silences the configured value the build never reads', () => {
  const settings = { optimizations: { android: { casToolchain: '/gone/toolchain.json' } } };
  expect(check(settings, ['/there/toolchain.json'], { STIM_ANDROID_CAS_TOOLCHAIN: '/there/toolchain.json' })).toEqual(
    [],
  );
});

test('a path setting is tested verbatim, because the build opens the string the config holds', () => {
  const settings = { optimizations: { android: { casToolchain: '/there/toolchain.json ' } } };
  expect(check(settings, ['/there/toolchain.json '])).toEqual([]);
  const findings = check(settings, ['/there/toolchain.json']);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.detail).toBe(
    `optimizations.android.casToolchain in ${MACHINE} names "/there/toolchain.json ", which does not exist.`,
  );
});

test('a key Stim no longer reads is named as inert', () => {
  const findings = check({ optimizations: { android: { gradleCache: false } } });
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ level: 'note', title: 'A key in the config is inert' });
  expect(findings[0]?.detail).toBe(
    `optimizations.android.gradleCache in ${MACHINE} is not read by Stim, so its value changes nothing.`,
  );
});

test('a config with nothing wrong reports nothing', () => {
  expect(check({ optimizations: { buildCache: true, android: { compilerCache: 'ccache' } } })).toEqual([]);
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
    delete process.env.STIM_HOME;
    if (savedToolchain === undefined) delete process.env.STIM_ANDROID_CAS_TOOLCHAIN;
    else process.env.STIM_ANDROID_CAS_TOOLCHAIN = savedToolchain;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  function writeConfig(config: Record<string, unknown>) {
    writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  }

  function machineSettings() {
    const layers = settingsLayers({ projectPath: project, gitCommonDir: null, repoRoot: project });
    return { layers, settings: mergeSettingsLayers(layers.map((layer) => layer.settings)) };
  }

  test('a projects entry for a checkout that is gone is left to gc while its settings are swept', () => {
    const dead = join(home, 'deleted-checkout');
    writeConfig({
      version: 2,
      repos: {},
      projects: {
        [dead]: { metroPort: 8081, platforms: {} },
        [project]: {
          metroPort: 8082,
          platforms: {},
          settings: { android: { keystore: 'app/release.keystore' } },
        },
      },
    });
    const findings = checkMachineSettings({ ...machineSettings(), projectRoot: project });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toBe(
      `android.keystore in ${join(home, 'config.json')} (projects["${project}"].settings) names ` +
        `${join(project, 'app', 'release.keystore')}, which does not exist.`,
    );
  });

  test('a setting committed in .stim.json is reported against that file', () => {
    writeConfig({ version: 2, repos: {}, projects: {} });
    writeFileSync(join(project, '.stim.json'), JSON.stringify({ android: { keystore: 'app/release.keystore' } }));
    const findings = checkMachineSettings({ ...machineSettings(), projectRoot: project });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toBe(
      `android.keystore in ${join(project, '.stim.json')} names ${join(project, 'app', 'release.keystore')}, ` +
        'which does not exist.',
    );
  });

  test('an unparseable config reports the repair line instead of crashing doctor', () => {
    writeFileSync(join(home, 'config.json'), '{ "projects": ');
    const machine = readMachineSettings({ projectPath: project, gitCommonDir: null, repoRoot: project });
    assert(machine.corrupt);
    expect(machine.corrupt.title).toBe('The Stim config is not valid JSON');
    expect(machine.corrupt.detail).toContain(join(home, 'config.json'));
    expect(machine.corrupt.fix).toBe(
      `Repair the file, or move it aside to start over: mv "${join(home, 'config.json')}" "${join(home, 'config.json')}.broken"`,
    );
    expect(runDoctor(project)).toEqual([machine.corrupt]);
  });

  test('doctor reports a toolchain the environment names but does not supply', () => {
    writeConfig({ version: 2, repos: {}, projects: {} });
    const missing = join(home, 'gone', 'toolchain.json');
    process.env.STIM_ANDROID_CAS_TOOLCHAIN = missing;
    const findings = runDoctor(project).filter((found) => found.detail.includes('STIM_ANDROID_CAS_TOOLCHAIN'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      level: 'note',
      title: 'An environment variable points at a path that is not there',
    });
    expect(findings[0]?.detail).toBe(
      `STIM_ANDROID_CAS_TOOLCHAIN in the environment names ${missing}, which does not exist.`,
    );
  });

  test('doctor reports a dead machine path on every platform, not only the native one', () => {
    writeConfig({
      version: 2,
      repos: {},
      projects: {},
      optimizations: { android: { compilerCache: 'cas', casToolchain: join(home, 'gone', 'toolchain.json') } },
    });
    for (const platform of [undefined, 'ios', 'android'] as const) {
      const findings = runDoctor(project, { platform }).filter((found) =>
        found.detail.includes('optimizations.android.casToolchain'),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.level).toBe('note');
    }
  });
});
