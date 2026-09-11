import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import { checkMachineSettings, readMachineSettings } from '../doctor-config.ts';
import { runDoctor } from '../doctor.ts';
import { resolveOptimizations } from '../optimizations.ts';
import { settingsLayers } from '../settings.ts';
import type { SettingsObject } from '../types.ts';

const MACHINE = '/home/.stim/config.json';

function check(settings: SettingsObject, present: string[] = []) {
  return checkMachineSettings({
    settings,
    layers: [{ file: MACHINE, settings }],
    projectRoot: '/app',
    optimizations: resolveOptimizations(settings, {}),
    exists: (path) => present.includes(path),
  });
}

test('a path setting that names a file which is not there is reported once, by key', () => {
  const findings = check({ optimizations: { android: { casToolchain: '/gone/toolchain.json' } } });
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ level: 'note', title: 'A setting points at a path that is not there' });
  expect(findings[0]?.detail).toContain('optimizations.android.casToolchain');
  expect(findings[0]?.detail).toContain(MACHINE);
  expect(findings[0]?.detail).toContain('/gone/toolchain.json');
  expect(findings[0]?.fix).toContain(MACHINE);
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
      'STIM_ANDROID_CAS_TOOLCHAIN names the toolchain manifest. Android builds use ccache.',
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

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-doctor-config-home-'));
    project = mkdtempSync(join(tmpdir(), 'stim-doctor-config-project-'));
    process.env.STIM_HOME = home;
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }));
    mkdirSync(join(project, 'node_modules'));
  });

  afterEach(() => {
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  function writeConfig(config: Record<string, unknown>) {
    writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  }

  test('a projects entry for a checkout that is gone is left to gc', () => {
    writeConfig({
      version: 2,
      repos: {},
      projects: { [join(home, 'deleted-checkout')]: { metroPort: 8081, platforms: {} } },
    });
    const layers = settingsLayers({ projectPath: project, gitCommonDir: null, repoRoot: project });
    expect(checkMachineSettings({ settings: {}, layers, projectRoot: project })).toEqual([]);
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
