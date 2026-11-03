import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  inspectPrebuildRecords,
  inspectSourceFacts,
  planSourceRepairs,
  prebuildRecordFinding,
  type SourceCheckoutFacts,
} from '../diagnostics/doctor-source.ts';
import { recordPrebuild } from '../engine/prebuild.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { installedTreeIsStaleAsync } from '../workspace/worktree-refresh.ts';
import { workspaceName } from '@stim-cli/core';

const IOS_UNFINISHED = { platform: 'ios', status: { kind: 'unfinished' } } as const;
const ANDROID_MOVED = { platform: 'android', status: { kind: 'moved', recorded: 'a', current: 'b' } } as const;

function facts(overrides: Partial<SourceCheckoutFacts> = {}): SourceCheckoutFacts {
  return { root: '/src/app', deps: null, pods: null, prebuild: [], ...overrides };
}

const DEPS = { root: '/src/app', command: 'npm ci', reason: 'stale' } as const;
const PODS = { iosDir: '/src/app/ios', broken: true, state: null, iosTracked: false } as const;

describe('planSourceRepairs', () => {
  test('a clean checkout plans nothing', () => {
    expect(planSourceRepairs(facts())).toEqual([]);
  });

  test('dependencies come first, then the iOS prebuild, which installs the Pods itself, then Android', () => {
    const steps = planSourceRepairs(facts({ deps: DEPS, pods: PODS, prebuild: [ANDROID_MOVED, IOS_UNFINISHED] }));
    expect(steps.map((step) => step.id)).toEqual(['deps', 'prebuild:ios', 'prebuild:android']);
    expect(steps[1]).toMatchObject({ cleanPods: true, mayUpdatePods: true });
  });

  test('broken Pods without a prebuild problem get their own clean-install step', () => {
    const [step] = planSourceRepairs(facts({ pods: PODS }));
    expect(step).toMatchObject({ id: 'pods', cleanPods: true });
    expect(step?.manual).toBe("cd '/src/app/ios' && pod install --clean-install");
  });

  test('stale Pods that hold no broken links are installed without --clean-install', () => {
    const [step] = planSourceRepairs(facts({ pods: { ...PODS, broken: false, state: 'stale' } }));
    expect(step?.cleanPods).toBe(false);
    expect(step?.manual).toBe("cd '/src/app/ios' && pod install");
  });

  test('an iOS prebuild with consistent Pods may still update a conflicting pod', () => {
    const [step] = planSourceRepairs(facts({ prebuild: [IOS_UNFINISHED] }));
    expect(step).toMatchObject({ id: 'prebuild:ios', cleanPods: false, mayUpdatePods: true });
  });

  test('a git-tracked ios/ never gets pod update', () => {
    const [step] = planSourceRepairs(facts({ pods: { ...PODS, iosTracked: true } }));
    expect(step?.mayUpdatePods).toBe(false);
  });

  test('only npm ci is announced as replacing the tree', () => {
    const [npm] = planSourceRepairs(facts({ deps: DEPS }));
    const [pnpm] = planSourceRepairs(facts({ deps: { ...DEPS, command: 'pnpm install', reason: 'missing' } }));
    expect(npm?.announce).toContain('deletes node_modules first');
    expect(pnpm?.announce).not.toContain('deletes node_modules');
    expect(pnpm?.announce).toContain('`pnpm install`');
  });
});

describe('prebuildRecordFinding', () => {
  test('an unfinished iOS record says worktrees install their own Pods', () => {
    const finding = prebuildRecordFinding(IOS_UNFINISHED);
    expect(finding).toMatchObject({ code: 'source-prebuild-record-ios', level: 'cost' });
    expect(finding.detail).toContain('did not finish');
    expect(finding.detail).toContain('its own Pods');
    expect(finding.fix).toContain('stim doctor --fix');
  });

  test('a moved Android record names the stale fingerprint without Pods', () => {
    const finding = prebuildRecordFinding(ANDROID_MOVED);
    expect(finding.detail).toContain('older fingerprint');
    expect(finding.detail).not.toContain('Pods');
  });
});

describe('installedTreeIsStaleAsync', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-tree-stale-'));
    process.env.STIM_HOME = home;
  });
  afterEach(() => {
    resetExecutor();
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  function npmReports(problems: string[]): void {
    setExecutor({
      ...getExecutor(),
      async runFileAsync() {
        throw Object.assign(new Error('npm ls failed'), { stdout: JSON.stringify({ problems }) });
      },
    });
  }

  function recordInstall(root: string, problems: string[]): void {
    const hash = createHash('sha256').update(problems.toSorted().join('\n')).digest('hex');
    mkdirSync(join(home, 'warm-installs'), { recursive: true });
    writeFileSync(
      join(home, 'warm-installs', `${workspaceName(root)}.json`),
      JSON.stringify({ lock: 'package-lock.json', hash: 'x', patches: '', completed: true, treeProblems: hash }),
    );
  }

  const dependencies = { lock: 'package-lock.json', installed: ['node_modules'], command: 'npm ci', root: '/work/app' };

  test('a tree npm rejects is stale until an install finished with those same problems', async () => {
    npmReports(['missing: react-dom@*, required by vaul@1.1.2']);
    expect(await installedTreeIsStaleAsync(dependencies)).toBe(true);
    recordInstall(dependencies.root, ['missing: react-dom@*, required by vaul@1.1.2']);
    expect(await installedTreeIsStaleAsync(dependencies)).toBe(false);
    npmReports(['missing: react-dom@*, required by vaul@1.1.2', 'invalid: ws@7.5.13']);
    expect(await installedTreeIsStaleAsync(dependencies)).toBe(true);
  });

  test('a tree npm accepts and a lockfile other than npm are never stale', async () => {
    setExecutor({ ...getExecutor(), runFileAsync: async () => '' });
    expect(await installedTreeIsStaleAsync(dependencies)).toBe(false);
    expect(await installedTreeIsStaleAsync({ ...dependencies, lock: 'pnpm-lock.yaml' })).toBe(false);
  });
});

describe('the source checkout on disk', () => {
  let base: string;
  let app: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'stim-doctor-source-'));
    app = join(base, 'app');
    process.env.STIM_HOME = join(base, 'stim-home');
    mkdirSync(app, { recursive: true });
    execFileSync('git', ['init', '-q', app]);
  });

  afterEach(() => {
    delete process.env.STIM_HOME;
    rmSync(base, { recursive: true, force: true });
  });

  function write(rel: string, value = ''): void {
    mkdirSync(dirname(join(app, rel)), { recursive: true });
    writeFileSync(join(app, rel), value);
  }

  function expoApp(): void {
    write('package.json', JSON.stringify({ name: 'app', dependencies: { expo: '55.0.0' } }));
    write('app.json', JSON.stringify({ expo: { name: 'app', slug: 'app' } }));
    write('.gitignore', '/ios\n/android\n');
    write('ios/Podfile');
    write('android/build.gradle');
  }

  test('an ignored native directory with an unfinished record is a problem on each platform asked about', async () => {
    expoApp();
    recordPrebuild(app, 'ios', null);
    recordPrebuild(app, 'android', null);
    const platforms = async (platform?: 'ios' | 'android', host: NodeJS.Platform = 'darwin') =>
      (await inspectPrebuildRecords({ root: app, platform, host })).map((problem) => problem.platform);
    expect(await platforms()).toEqual(['ios', 'android']);
    expect(await platforms('ios')).toEqual(['ios']);
    expect(await platforms('android')).toEqual(['android']);
    expect(await platforms(undefined, 'linux')).toEqual(['android']);
  });

  test('a git-tracked native directory, a missing one and a bare project need no record', async () => {
    expoApp();
    write('.gitignore', '/android\n');
    execFileSync('git', ['-C', app, 'add', '-f', 'ios/Podfile']);
    rmSync(join(app, 'android'), { recursive: true });
    expect(await inspectPrebuildRecords({ root: app, host: 'darwin' })).toEqual([]);

    write('package.json', JSON.stringify({ name: 'app', dependencies: { 'react-native': '0.80.0' } }));
    write('android/build.gradle');
    write('.gitignore', '/android\n');
    expect(await inspectPrebuildRecords({ root: app, host: 'darwin' })).toEqual([]);
  });

  function podsApp(): void {
    expoApp();
    write('package-lock.json', '{}');
    write('ios/Podfile.lock', 'PODS: []\n');
    mkdirSync(join(app, 'ios', 'Pods', 'Headers'), { recursive: true });
  }

  const readFacts = (tracked: boolean, platform?: 'android') => {
    if (tracked) execFileSync('git', ['-C', app, 'add', '-f', 'ios/Podfile.lock']);
    return inspectSourceFacts({ root: app, repoRoot: app, platform, host: 'darwin', iosProjectPath: 'ios' });
  };

  test('missing dependencies and a missing Pods manifest are read the way the findings read them', async () => {
    podsApp();
    const untracked = await readFacts(false);
    expect(untracked.deps).toMatchObject({ command: 'npm ci', reason: 'missing' });
    expect(untracked.pods).toMatchObject({ state: 'missing', iosTracked: false });
    expect((await readFacts(true)).pods?.iosTracked).toBe(true);
    expect((await readFacts(true, 'android')).pods).toBeNull();
  });

  test.skipIf(process.platform === 'win32')(
    'Pods with a broken link are reported as broken (find -L over ios/Pods, which exists only on macOS; skipped on win32)',
    async () => {
      podsApp();
      symlinkSync(join(app, 'gone.h'), join(app, 'ios', 'Pods', 'Headers', 'gone.h'));
      expect((await readFacts(false)).pods).toMatchObject({ broken: true, state: 'missing' });
    },
  );
});
