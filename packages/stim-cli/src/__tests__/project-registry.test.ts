import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createProjectRegistry, type ProjectIntegration } from '../integrations/project-registry.ts';
import { projectIntegrations, projectRegistry } from '../integrations/projects.ts';

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
