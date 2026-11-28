import { testContext } from './_context.ts';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildAndroidOperation } from '../commands/android/build.ts';
import { androidBuildToolName } from '../devices/android.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { makeExecutor, makeExitingChild } from './_factories.ts';

let directory: string;
let root: string;
let runs: { file: string; args: readonly string[]; cwd: unknown }[];
let exportApk: (output: string) => number;

function write(path: string, content = '') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function plugin(build: Record<string, unknown>) {
  const dir = join(directory, 'stim-plugin-game');
  write(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'stim-plugin-game',
      stimPlugin: {
        kinds: { project: 1 },
        project: { id: 'game', name: 'Game', markers: ['game.project'], targets: { android: { build } } },
      },
    }),
  );
  write(join(directory, 'state', 'config.json'), JSON.stringify({ plugins: [dir] }));
}

const build = (variant?: string) =>
  buildAndroidOperation(testContext(), root, { remoteBuild: 'local', ...(variant ? { variant } : {}) });

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'stim-plugin-android-')));
  root = join(directory, 'game');
  const sdk = join(directory, 'sdk');
  for (const [key, value] of Object.entries({
    HOME: join(directory, 'home'),
    USERPROFILE: join(directory, 'home'),
    ANDROID_HOME: sdk,
    STIM_HOME: join(directory, 'state'),
    STIM_BUILD_CACHE: join(directory, 'cache'),
  }))
    vi.stubEnv(key, value);
  for (const tool of ['aapt', 'apksigner']) write(join(sdk, 'build-tools', '36.0.0', androidBuildToolName(tool)));
  write(join(root, 'game.project'));
  plugin({
    debug: ['export-tool', '--path', '{root}', '--debug', '{output}'],
    release: ['export-tool', '--path', '{root}', '--release', '{output}'],
    output: 'apk',
  });
  runs = [];
  exportApk = (output) => {
    write(output, `apk ${runs.length}`);
    return 0;
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setExecutor(
    makeExecutor({
      spawn: (file, args = [], options) => {
        runs.push({ file, args, cwd: options?.cwd });
        const code = exportApk(args.at(-1) ?? '');
        return makeExitingChild(code, code === 0 ? '' : 'ERROR: the export preset was not found\n');
      },
      runFileAsync: async (file) => {
        if (file.endsWith(androidBuildToolName('apksigner')))
          return `Signer #1 certificate SHA-256 digest: ${'a'.repeat(64)}\n`;
        if (file.endsWith(androidBuildToolName('aapt')))
          return "package: name='dev.example.game' versionCode='1'\nnative-code: 'arm64-v8a'\n";
        return '';
      },
    }),
  );
});

afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

test('a declared Android build runs the plugin command in the project root and takes the APK it wrote outside the tree', async () => {
  const debug = await build();
  const output = join(workspaceDir(root), 'plugin-build', 'android-debug.apk');
  expect(runs).toEqual([{ file: 'export-tool', args: ['--path', root, '--debug', output], cwd: root }]);
  expect(debug).toMatchObject({
    androidPackage: 'dev.example.game',
    variant: 'debug',
    cacheHit: false,
    cacheSkipped: true,
    cacheKey: null,
    builtOn: 'here',
  });
  expect(readFileSync(debug.apkPath, 'utf8')).toBe('apk 1');

  await build('release');
  expect(runs[1]?.args).toEqual([
    '--path',
    root,
    '--release',
    join(workspaceDir(root), 'plugin-build', 'android-release.apk'),
  ]);
});

test('a build command that exits 0 without writing its output fails, and an earlier APK does not stand in for it', async () => {
  await build();
  exportApk = () => 0;
  await expect(build()).rejects.toMatchObject({
    code: 'STIM_BUILD_FAILED',
    message: expect.stringMatching(/stim-plugin-game \(export-tool\) exited with code 0 and wrote no APK at /),
  });
});

test('a build command that exits non-zero fails with its last output', async () => {
  exportApk = () => 1;
  await expect(build()).rejects.toMatchObject({
    code: 'STIM_BUILD_FAILED',
    message: 'The Android build command of the plugin stim-plugin-game (export-tool) exited with code 1.',
    details: { lines: ['ERROR: the export preset was not found'] },
  });
});

test('a variant the plugin declares no command for refuses before anything runs', async () => {
  plugin({ debug: ['export-tool', '{output}'], output: 'apk' });
  await expect(build('release')).rejects.toMatchObject({
    code: 'STIM_BAD_ARG',
    message: 'The plugin stim-plugin-game declares no Android build for the variant "release".',
  });
  expect(runs).toEqual([]);
});
