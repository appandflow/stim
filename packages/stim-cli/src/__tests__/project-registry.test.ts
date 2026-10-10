import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findProjectRoot as findCoreProjectRoot } from '@stim-cli/core/state';
import { createProjectRegistry, type ProjectIntegration } from '../integrations/project-registry.ts';
import { projectIntegrations, projectRegistry } from '../integrations/projects.ts';
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
    projectRegistry.detectPlatforms(dir, {
      context: { projectPath: dir, gitCommonDir: null, repoRoot: null },
      settings: {},
    }),
  ).toEqual([]);
  expect(projectRegistry.projectProblem(dir, 'ios')).toBeNull();
  expect(projectRegistry.projectProblem(dir, 'android')).toBeNull();
  write(join(dir, 'Package.swift'));
  const settings = { macos: { product: 'App', infoPlist: 'Info.plist' }, web: { url: 'http://localhost:8000' } };
  expect(
    projectRegistry.detectPlatforms(dir, {
      context: { projectPath: dir, gitCommonDir: null, repoRoot: null },
      settings: settings,
    }),
  ).toEqual(['macos', 'web']);
  expect(projectRegistry.projectProblem(dir, 'dev-server')).toBeNull();

  write(join(dir, 'package.json'), JSON.stringify({ dependencies: { expo: '57.0.0' } }));
  write(join(dir, 'app.json'), JSON.stringify({ expo: { platforms: ['web'] } }));
  expect(
    projectRegistry.detectPlatforms(dir, {
      context: { projectPath: dir, gitCommonDir: null, repoRoot: null },
      settings: {},
    }),
  ).toEqual(['web']);
  expect(projectRegistry.projectProblem(dir, 'ios')).toBeNull();
  expect(projectRegistry.projectProblem(dir, 'android')).toBeNull();
});

test('adding test integrations discovers the nearest independent app without changing production discovery', () => {
  packageAt(dir, false);
  const app = join(dir, 'apps', 'native');
  write(join(app, 'App.xcodeproj'));
  write(join(app, 'build.gradle.kts'));
  const nested = join(app, 'src');
  mkdirSync(nested);
  expect(findCoreProjectRoot(nested)).toBe(dir);
  expect(projectRegistry.findProjectRoot(nested)).toBe(dir);
  expect(registry.findProjectRoot(nested)).toBe(app);
  expect(
    registry.detectPlatforms(app, { context: { projectPath: app, gitCommonDir: null, repoRoot: null }, settings: {} }),
  ).toEqual(['ios', 'android']);
  expect(registry.projectProblem(app, 'ios')).toBeNull();
  expect(registry.projectProblem(app, 'android')).toBeNull();
  expect(registry.projectProblem(app, 'dev-server')?.kind).toBe('not-an-app');
});

test('a same-root tooling manifest does not veto disjoint test operation providers', () => {
  packageAt(dir, false);
  write(join(dir, 'App.xcodeproj'));
  write(join(dir, 'build.gradle.kts'));
  expect(registry.findProjectRoot(dir)).toBe(dir);
  expect(registry.projectProblem(dir, 'ios')).toBeNull();
  expect(registry.projectProblem(dir, 'android')).toBeNull();
  expect(registry.projectProblem(dir, 'dev-server')?.kind).toBe('not-an-app');
});

test('multiple providers for the same requested operation refuse with both identities', () => {
  packageAt(dir);
  write(join(dir, 'App.xcodeproj'));
  const problem = registry.projectProblem(dir, 'ios');
  expect(problem?.kind).toBe('ambiguous');
  expect(problem?.message).toContain('react-native');
  expect(problem?.message).toContain('test-ios');
  expect(problem?.message).toContain(dir);
  expect(registry.projectProblem(dir, 'android')).toBeNull();
});

test.each(['ios', 'android'] as const)('only the exact RN-owned %s candidate is absorbed', (platform) => {
  packageAt(dir);
  const owned = join(dir, platform);
  const marker = platform === 'ios' ? 'App.xcodeproj' : 'build.gradle.kts';
  write(join(owned, marker));
  const source = join(owned, 'src');
  mkdirSync(source);
  expect(registry.findProjectRoot(source)).toBe(dir);
  const refusal = registry.projectProblem(owned, platform);
  expect(refusal?.kind).toBe('not-an-app');
  expect(refusal?.message).toContain(owned);
  expect(refusal?.remedy).toContain(dir);

  const nested = join(owned, 'independent');
  write(join(nested, marker));
  expect(registry.findProjectRoot(nested)).toBe(nested);
  const sibling = join(dir, `${platform}-other`);
  write(join(sibling, marker));
  expect(registry.findProjectRoot(sibling)).toBe(sibling);

  packageAt(owned);
  expect(registry.findProjectRoot(source)).toBe(owned);
});

test('an independent Swift package at an RN native directory keeps its own root', () => {
  packageAt(dir);
  const swift = join(dir, 'ios');
  write(join(swift, 'Package.swift'));
  write(join(swift, 'App.xcodeproj'));
  expect(registry.findProjectRoot(swift)).toBe(swift);
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
  getExecutor().runFile('git', ['-C', dir, 'init', '-q']);
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

test('registered redirects use integration admission while a nearer independent app retains its root', () => {
  packageAt(dir, false);
  getExecutor().runFile('git', ['-C', dir, 'init', '-q']);
  const app = join(dir, 'native');
  write(join(app, 'App.xcodeproj'));
  upsertProject(app, {});
  const tools = join(dir, 'tools');
  packageAt(tools, false);
  expect(findServerWorkspace(tools, registry)).toEqual({ root: app, from: tools });
  packageAt(dir);
  upsertProject(dir, {});
  expect(findServerWorkspace(app, registry)).toEqual({ root: app, from: null });
});

test('explicit operation validation does not substitute an enclosing RN app', () => {
  packageAt(dir);
  const child = join(dir, 'tools');
  packageAt(child, false);
  const problem = projectRegistry.projectProblem(child, 'ios');
  expect(problem?.kind).toBe('not-an-app');
  expect(problem?.message).toContain(join(child, 'package.json'));
  expect(projectRegistry.projectProblem(join(dir, 'src'), 'android')?.kind).toBe('not-an-app');
});

test.each([JSON.stringify({ dependencies: { 'react-native': '0.81.0' } }), JSON.stringify({ name: 'tools' }), '{'])(
  'SwiftPM selection is independent of the same-root package manifest %s',
  async (manifest) => {
    write(join(dir, 'Package.swift'));
    write(join(dir, 'package.json'), manifest);
    const selected = projectRegistry.selectMacos(dir);
    if ('problem' in selected) throw new Error(selected.problem.message);
    const project = await selected.load();
    expect(() => project.prepare({})).toThrow(expect.objectContaining({ code: 'STIM_BAD_ARG' }));
  },
);

test('macOS selection uses the exact canonical package root and refuses multiple providers', () => {
  write(join(dir, 'Package.swift'));
  const alias = join(dir, 'alias');
  symlinkSync(dir, alias, 'junction');
  expect(projectRegistry.projectProblem(alias, 'macos')).toBeNull();
  const nested = join(dir, 'Sources');
  mkdirSync(nested);
  expect(projectRegistry.selectMacos(nested)).toMatchObject({ problem: { kind: 'not-an-app' } });
  const competing = createProjectRegistry([
    ...projectIntegrations,
    {
      id: 'other-macos',
      inspect: () => ({
        root: false,
        application: false,
        platforms: () => ['macos'],
        validate: (operation) => (operation === 'macos' ? null : undefined),
      }),
    },
  ]);
  const selected = competing.selectMacos(dir);
  expect(selected).toMatchObject({ problem: { kind: 'ambiguous' } });
  if (!('problem' in selected)) throw new Error('Competing macOS providers must refuse.');
  expect(selected.problem.message).toContain('swift-package');
  expect(selected.problem.message).toContain('other-macos');
});
