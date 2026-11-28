import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createProjectRegistry,
  unownedProjectState,
  type ProjectIntegration,
} from '../integrations/project-registry.ts';
import { configuredProjectPlugins, projectIntegrations, projectRegistry } from '../integrations/projects.ts';
import { findServerWorkspace } from '../workspace/project.ts';
import { upsertProject } from '../workspace/config.ts';
import { getExecutor } from '../exec.ts';

const testIos: ProjectIntegration = {
  id: 'test-ios',
  inspect(root) {
    if (!existsSync(join(root, 'App.xcodeproj'))) return null;
    return {
      root: 'candidate',
      application: true,
      platforms: () => ['ios'],
      validate: (operation) => (operation === 'ios' ? null : undefined),
    };
  },
};

const testAndroid: ProjectIntegration = {
  id: 'test-android',
  inspect(root) {
    if (!existsSync(join(root, 'build.gradle.kts'))) return null;
    return {
      root: 'candidate',
      application: true,
      platforms: () => ['android'],
      validate: (operation) => (operation === 'android' ? null : undefined),
    };
  },
};

const registry = createProjectRegistry([...projectIntegrations, testIos, testAndroid]);
let dir: string;
let home: string;

function write(path: string, text = '') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function packageAt(root: string, app = true) {
  write(
    join(root, 'package.json'),
    JSON.stringify(app ? { dependencies: { 'react-native': '0.81.0' } } : { name: 'tools' }),
  );
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'stim-project-registry-')));
  home = mkdtempSync(join(tmpdir(), 'stim-home-'));
  process.env.STIM_HOME = home;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('RN admission is independent of advertised platforms and composes with SwiftPM and configured web', () => {
  packageAt(dir);
  expect(
    projectRegistry.detectProject(dir, {
      context: { projectPath: dir, gitCommonDir: null, repoRoot: null },
      settings: {},
    }).platforms,
  ).toEqual([]);
  expect(projectRegistry.projectProblem(dir, 'ios')).toBeNull();
  expect(projectRegistry.projectProblem(dir, 'android')).toBeNull();
  write(join(dir, 'Package.swift'));
  const settings = { macos: { product: 'App', infoPlist: 'Info.plist' }, web: { url: 'http://localhost:8000' } };
  expect(
    projectRegistry.detectProject(dir, {
      context: { projectPath: dir, gitCommonDir: null, repoRoot: null },
      settings: settings,
    }).platforms,
  ).toEqual(['macos', 'web']);
  expect(projectRegistry.projectProblem(dir, 'dev-server')).toBeNull();

  write(join(dir, 'package.json'), JSON.stringify({ dependencies: { expo: '57.0.0' } }));
  write(join(dir, 'app.json'), JSON.stringify({ expo: { platforms: ['web'] } }));
  expect(
    projectRegistry.detectProject(dir, {
      context: { projectPath: dir, gitCommonDir: null, repoRoot: null },
      settings: {},
    }).platforms,
  ).toEqual(['web']);
  expect(projectRegistry.projectProblem(dir, 'ios')).toBeNull();
  expect(projectRegistry.projectProblem(dir, 'android')).toBeNull();
});

test('an Exact app selects the exact integration for iOS and has no dev server, while an Expo app.json stays React Native', () => {
  const exact = join(dir, 'exact');
  write(join(exact, 'package.json'), JSON.stringify({ name: 'shop', private: true }));
  write(join(exact, 'app.json'), JSON.stringify({ app: { id: 'com.example.shop' }, host: { ios: {} } }));
  write(join(exact, 'exact.mjs'));
  const ios = projectRegistry.selectIos(exact);
  expect('id' in ios ? ios.id : ios.problem.message).toBe('exact');
  for (const operation of ['android', 'dev-server'] as const) {
    const problem = projectRegistry.projectProblem(exact, operation);
    expect(problem?.kind).toBe('not-an-app');
    expect(problem?.message).toMatch(/is an Exact app/);
    expect(problem?.remedy).toMatch(/stim ios/);
  }

  const expo = join(dir, 'expo');
  write(join(expo, 'package.json'), JSON.stringify({ dependencies: { expo: '57.0.0' } }));
  write(join(expo, 'app.json'), JSON.stringify({ expo: {} }));
  const expoIos = projectRegistry.selectIos(expo);
  expect('id' in expoIos ? expoIos.id : expoIos.problem.message).toBe('react-native');

  const detect = (root: string) =>
    projectRegistry.detectProject(root, {
      context: { projectPath: root, gitCommonDir: null, repoRoot: null },
      settings: {},
    });
  expect(detect(exact)).toEqual({ platforms: ['ios'], devServer: false });
  expect(detect(expo).devServer).toBe(true);
  write(join(expo, 'package.json'), '{ "dependencies": ');
  expect(detect(expo).devServer).toBe(true);
});

test('symlinks resolve native ownership and workspace identity by canonical paths', () => {
  const app = join(dir, 'app');
  packageAt(app);
  const native = join(app, 'native-project');
  write(join(native, 'App.xcodeproj'));
  symlinkSync(native, join(app, 'ios'), 'junction');
  const alias = join(dir, 'alias');
  symlinkSync(app, alias, 'junction');
  expect(registry.findProjectRoot(join(alias, 'ios'))).toBe(app);
  expect(registry.projectProblem(join(alias, 'ios'), 'ios')?.remedy).toContain(app);
  expect(registry.projectProblem(alias, 'ios')).toBeNull();
});

test('unreadable relevant manifests refuse instead of falling back to another integration or registered app', () => {
  packageAt(dir);
  getExecutor().runFile('git', ['-C', dir, 'init', '-q'], { timeoutMs: 60_000 });
  upsertProject(dir, {});
  const nested = join(dir, 'nested');
  write(join(nested, 'package.json'), '{');
  write(join(nested, 'App.xcodeproj'));
  expect(registry.findProjectRoot(nested)).toBe(nested);
  const problem = registry.projectProblem(nested, 'ios');
  expect(problem?.kind).toBe('unreadable');
  expect(problem?.message).toContain(join(nested, 'package.json'));
  expect(problem?.remedy).toMatch(/Fix the JSON/);
  expect(findServerWorkspace(nested, registry)).toEqual({ root: nested, from: null });
});

test.each(['swift', 'exact', 'expo'] as const)('selected-root recognition preserves the %s integration', (kind) => {
  if (kind === 'swift') write(join(dir, 'Package.swift'));
  else if (kind === 'exact') {
    write(join(dir, 'exact.mjs'));
    write(join(dir, 'app.json'), '{}');
  } else packageAt(dir);
  expect(projectRegistry.selectDoctor(dir).problem).toBeNull();
  expect(unownedProjectState(dir, projectIntegrations)).toBe(true);
});

test('selected-root recognition preserves operation ambiguity and unreadable refusal', () => {
  packageAt(dir);
  write(join(dir, 'exact.mjs'));
  write(join(dir, 'app.json'), '{}');
  expect(projectRegistry.selectDoctor(dir).problem?.kind).toBe('ambiguous');
  expect(unownedProjectState(dir, projectIntegrations)).toBe(false);
  write(join(dir, 'package.json'), '{');
  expect(projectRegistry.selectDoctor(dir).problem?.kind).toBe('unreadable');
  expect(unownedProjectState(dir, projectIntegrations)).toBe('unknown');
});

function projectPlugin(name: string, project: unknown, kinds: unknown = { project: 1 }): string {
  const plugin = join(home, name);
  write(join(plugin, 'package.json'), JSON.stringify({ name, stimPlugin: { kinds, project } }));
  return plugin;
}

function setPlugins(...plugins: string[]) {
  write(join(home, 'config.json'), JSON.stringify({ plugins }));
}

const godot = { id: 'godot', name: 'Godot', markers: ['project.godot', 'export_presets.cfg'] };

test('a plugins entry makes a folder holding every marker a project with no build or run, until the entry leaves the setting', () => {
  const game = join(dir, 'game');
  write(join(game, 'project.godot'));
  write(join(game, 'scenes', 'main.tscn'));
  const plugin = projectPlugin('stim-plugin-godot', godot);
  expect(projectRegistry.findProjectRoot(join(game, 'scenes'))).toBeNull();

  setPlugins(plugin);
  expect(projectRegistry.findProjectRoot(join(game, 'scenes'))).toBeNull();

  write(join(game, 'export_presets.cfg'));
  expect(projectRegistry.findProjectRoot(join(game, 'scenes'))).toBe(game);
  expect(projectRegistry.keepsWorkspace(game)).toBe(true);
  expect(projectRegistry.isMobileProject(game)).toBe(false);
  for (const operation of ['ios', 'android', 'macos', 'dev-server'] as const) {
    const problem = projectRegistry.projectProblem(game, operation);
    expect(problem?.kind).toBe('not-an-app');
    expect(problem?.message).toBe(
      `The plugin stim-plugin-godot recognises ${game} as a Godot project and adds no build or run for it.`,
    );
    expect(problem?.remedy).toContain("Godot's own tools");
  }

  setPlugins();
  expect(projectRegistry.findProjectRoot(join(game, 'scenes'))).toBeNull();
  expect(projectRegistry.keepsWorkspace(game)).toBe(false);
});

test('a plugin marker in a React Native app keeps the built-in build and run', () => {
  packageAt(dir);
  write(join(dir, 'project.godot'));
  setPlugins(projectPlugin('stim-plugin-godot', { ...godot, markers: ['project.godot'] }));
  expect(projectRegistry.selectIos(dir)).toMatchObject({ id: 'react-native' });
  expect(projectRegistry.selectAndroid(dir)).toMatchObject({ id: 'react-native' });
  expect(projectRegistry.projectProblem(dir, 'dev-server')).toBeNull();
  expect(projectRegistry.projectProblem(dir, 'macos')?.message).toContain('adds no build or run for it');
});

test.each([
  [
    'the id of a bundled integration',
    { ...godot, id: 'exact' },
    { project: 1 },
    /"exact" is the id of a project integration Stim bundles/,
  ],
  ['an id that is not lowercase', { ...godot, id: 'Godot' }, { project: 1 }, /stimPlugin\.project\.id is "Godot"/],
  ['a name that spans lines', { ...godot, name: 'Godot\nEngine' }, { project: 1 }, /stimPlugin\.project\.name/],
  [
    'a marker in a subfolder',
    { ...godot, markers: ['addons/plugin.cfg'] },
    { project: 1 },
    /holds "addons\/plugin\.cfg"/,
  ],
  ['a glob marker', { ...godot, markers: ['*.godot'] }, { project: 1 }, /holds "\*\.godot"/],
  ['a marker that is not a string', { ...godot, markers: ['project.godot', 7] }, { project: 1 }, /holds 7/],
  ['no marker', { ...godot, markers: [] }, { project: 1 }, /markers must be an array of 1 to 16 file names/],
  ['no project block', undefined, { project: 1 }, /stimPlugin\.project must be an object/],
  ['another integer', godot, { project: 2 }, /speaks project 2, this stim speaks 1/],
  ['another kind only', godot, { transport: 1 }, /is not a project plugin/],
])('a project plugin that declares %s is skipped, with the reason', (_, project, kinds, reason) => {
  for (const marker of ['project.godot', 'export_presets.cfg', 'addons/plugin.cfg']) write(join(dir, marker));
  setPlugins(projectPlugin('stim-plugin-godot', project, kinds));
  expect(projectRegistry.findProjectRoot(dir)).toBeNull();
  expect(configuredProjectPlugins()).toEqual([
    expect.objectContaining({ project: null, problem: expect.stringMatching(reason) }),
  ]);
});

test('a package.json edit is read without a settings change, and a second plugin cannot take an accepted id', () => {
  write(join(dir, 'project.godot'));
  write(join(dir, 'export_presets.cfg'));
  const first = join(home, 'first');
  write(join(first, 'package.json'), '{ "name": "first", "stimPlugin": ');
  const second = projectPlugin('second', { ...godot, name: 'Second' });
  setPlugins(first, second);
  expect(configuredProjectPlugins()[0]?.problem).toMatch(/package\.json is not valid JSON/);
  expect(projectRegistry.projectProblem(dir, 'ios')?.message).toContain('as a Second project');

  projectPlugin('first', godot);
  expect(projectRegistry.projectProblem(dir, 'ios')?.message).toContain('as a Godot project');
  expect(configuredProjectPlugins()[1]).toMatchObject({
    project: null,
    problem: `stimPlugin.project.id "godot" is the id of the plugin at ${first}`,
  });
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'a plugins entry Stim cannot read is skipped with its reason, and detection goes on',
  () => {
    packageAt(dir);
    write(join(dir, 'project.godot'));
    const locked = projectPlugin('locked', godot);
    const open = projectPlugin('open', { ...godot, id: 'open', name: 'Open', markers: ['project.godot'] });
    setPlugins(locked, open);
    chmodSync(locked, 0o000);
    try {
      expect(projectRegistry.selectIos(dir)).toMatchObject({ id: 'react-native' });
      expect(projectRegistry.projectProblem(dir, 'macos')?.message).toContain('as a Open project');
      expect(configuredProjectPlugins()).toEqual([
        expect.objectContaining({
          project: null,
          problem: expect.stringMatching(/has no readable package\.json: EACCES/),
        }),
        expect.objectContaining({ problem: null }),
      ]);
    } finally {
      chmodSync(locked, 0o755);
    }
    expect(configuredProjectPlugins()[0]).toMatchObject({ problem: null, project: { id: 'godot' } });
  },
);
