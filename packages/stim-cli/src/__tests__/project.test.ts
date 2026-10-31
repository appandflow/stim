import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import { detectPlatforms } from '../integrations/projects.ts';
import { detectIsExpo, ownedDeviceLabel } from '../workspace/project.ts';
import { detectAndroidPackage, detectBundleId } from '../workspace/app-id.ts';
import { getExecutor } from '../exec.ts';

const FIXTURES = resolve(import.meta.dirname, 'fixtures');
const EXPO_PROJ = join(FIXTURES, 'sample-expo-project');
const BARE_PROJ = join(FIXTURES, 'sample-bare-project');

test('owned device labels distinguish worktrees and apps, collapse equal basenames, and resolve symlinks', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stim-labels-')));
  const main = join(tmp, 'My.App');
  const worktree = join(tmp, 'pr6460');
  const git = (cwd: string, ...args: string[]) =>
    getExecutor().runFile('git', ['-C', cwd, ...args], { timeoutMs: 60_000 });
  try {
    mkdirSync(main);
    git(main, 'init');
    git(main, 'config', 'commit.gpgsign', 'false');
    git(main, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'init');
    git(main, 'worktree', 'add', '-b', 'review', worktree);
    const app = join(worktree, 'apps', 'tlon-mobile');
    const otherApp = join(worktree, 'apps', 'tlon-desktop');
    const mainApp = join(main, 'apps', 'tlon-mobile');
    for (const root of [app, otherApp, mainApp]) mkdirSync(root, { recursive: true });
    const alias = join(tmp, 'alias');
    symlinkSync(app, alias);
    expect(ownedDeviceLabel(main)).toBe('My.App');
    expect(ownedDeviceLabel(app)).toBe('pr6460-tlon-mobile');
    expect(ownedDeviceLabel(otherApp)).toBe('pr6460-tlon-desktop');
    expect(ownedDeviceLabel(mainApp)).toBe('My.App-tlon-mobile');
    expect(ownedDeviceLabel(alias)).toBe(ownedDeviceLabel(app));
    const standalone = join(tmp, '@Standalone App');
    mkdirSync(standalone);
    expect(ownedDeviceLabel(standalone)).toBe('@Standalone App');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('detectIsExpo trusts the ios script: react-native script wins even with expo dep', async () => {
  const tmp = mkdtempSync(join((await import('os')).tmpdir(), 'stim-detect-'));
  try {
    writeFileSync(
      join(tmp, 'package.json'),
      JSON.stringify({
        dependencies: { expo: '54.0.33' },
        scripts: { ios: "react-native run-ios --simulator='iPhone 16 Pro'" },
      }),
    );
    expect(detectIsExpo(tmp)).toBe(false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

describe('detectPlatforms without running project code', () => {
  let root: string;
  const file = (name: string, contents = '') => {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), contents);
  };
  const app = (dependencies: Record<string, string>) => file('package.json', JSON.stringify({ dependencies }));
  const expo = (platforms?: string[]) => {
    app({ expo: '54' });
    file('app.json', JSON.stringify({ expo: { slug: 'app', ...(platforms ? { platforms } : {}) } }));
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stim-platforms-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('fresh bare native projects and Android-only Kotlin projects', () => {
    app({ 'react-native': '0.81' });
    file('ios/App.xcodeproj/project.pbxproj');
    file('android/build.gradle');
    expect(
      detectPlatforms(root, { context: { projectPath: root, gitCommonDir: null, repoRoot: null }, settings: {} }),
    ).toEqual(['ios', 'android']);
    rmSync(join(root, 'ios'), { recursive: true });
    rmSync(join(root, 'android/build.gradle'));
    file('android/settings.gradle.kts');
    expect(
      detectPlatforms(root, { context: { projectPath: root, gitCommonDir: null, repoRoot: null }, settings: {} }),
    ).toEqual(['android']);
    file('ios/App.xcworkspace/contents.xcworkspacedata');
    expect(
      detectPlatforms(root, { context: { projectPath: root, gitCommonDir: null, repoRoot: null }, settings: {} }),
    ).toEqual(['ios', 'android']);
  });

  test('Expo defaults work before prebuild and explicit platforms constrain native and web support', () => {
    expo();
    expect(
      detectPlatforms(root, { context: { projectPath: root, gitCommonDir: null, repoRoot: null }, settings: {} }),
    ).toEqual(['ios', 'android']);
    file('node_modules/react-native-web/package.json', '{}');
    expect(
      detectPlatforms(root, { context: { projectPath: root, gitCommonDir: null, repoRoot: null }, settings: {} }),
    ).toEqual(['ios', 'android', 'web']);
    expo(['ios']);
    expect(
      detectPlatforms(root, { context: { projectPath: root, gitCommonDir: null, repoRoot: null }, settings: {} }),
    ).toEqual(['ios']);
    expect(
      detectPlatforms(root, {
        context: { projectPath: root, gitCommonDir: null, repoRoot: null },
        settings: { web: { url: 'http://localhost:5173' } },
      }),
    ).toEqual(['ios', 'web']);
    file('app.json', JSON.stringify({ slug: 'app', platforms: ['web'] }));
    expect(
      detectPlatforms(root, { context: { projectPath: root, gitCommonDir: null, repoRoot: null }, settings: {} }),
    ).toEqual(['web']);
  });

  test.each(['js', 'ts', 'cjs', 'mjs'])(
    'dynamic app.config.%s reads only literal arrays and never executes',
    (extension) => {
      expo();
      file(
        `app.config.${extension}`,
        "throw new Error('must not execute'); export default { platforms: ['web', 'ios'] };",
      );
      expect(
        detectPlatforms(root, { context: { projectPath: root, gitCommonDir: null, repoRoot: null }, settings: {} }),
      ).toEqual(['ios', 'web']);
      file(
        `app.config.${extension}`,
        "throw new Error('must not execute'); export default { platforms: choosePlatforms() };",
      );
      expect(
        detectPlatforms(root, { context: { projectPath: root, gitCommonDir: null, repoRoot: null }, settings: {} }),
      ).toEqual(['ios', 'android']);
      file(`app.config.${extension}`, "export default { platforms: ['ios', ...otherPlatforms] };");
      expect(
        detectPlatforms(root, { context: { projectPath: root, gitCommonDir: null, repoRoot: null }, settings: {} }),
      ).toEqual(['ios', 'android']);
      file(`app.config.${extension}`, "// platforms: ['web']\nexport default { slug: 'app' };");
      expect(
        detectPlatforms(root, { context: { projectPath: root, gitCommonDir: null, repoRoot: null }, settings: {} }),
      ).toEqual(['ios', 'android']);
      expo(['android']);
      expect(
        detectPlatforms(root, { context: { projectPath: root, gitCommonDir: null, repoRoot: null }, settings: {} }),
      ).toEqual(['android']);
      file(
        `app.config.${extension}`,
        "export default { plugins: [['some-plugin', { platforms: ['ios'] }]], slug: 'app' };",
      );
      expect(
        detectPlatforms(root, { context: { projectPath: root, gitCommonDir: null, repoRoot: null }, settings: {} }),
      ).toEqual(['android']);
    },
  );
});

test('detectBundleId reads ios.bundleIdentifier from app.json', async () => {
  expect(await detectBundleId(EXPO_PROJ)).toBe('com.example.sample');
});

test('detectAndroidPackage falls back to android/app/build.gradle (namespace)', async () => {
  expect(await detectAndroidPackage(BARE_PROJ)).toBe('me.sample');
});

let tmpHome: string;
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-resolve-'));
  process.env.STIM_HOME = tmpHome;
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});
