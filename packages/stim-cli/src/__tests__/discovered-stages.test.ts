import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@stim-cli/core/state';
import { runDormantDependencies } from '../daemon/dependencies.ts';
import { clearStoppedOutputs, stoppedOutputCandidates } from '../daemon/stages.ts';
import { execFileSync } from 'node:child_process';
import { testContext } from './_context.ts';
import { loadConfig, saveConfig } from '../workspace/config.ts';

const fail = (): never => {
  throw new Error('no candidate');
};

vi.mock('../workspace/protected-locations.ts', () => ({ isProtectedLocation: () => false }));

describe('a discovered checkout in the idle stages', () => {
  let base: string;
  const day = 86_400_000;
  const reading = { devices: [], simsFailed: false };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-discovered-stage-')));
    vi.stubEnv('STIM_HOME', join(base, 'home'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it('is a candidate once its source is idle, is kept after an edit, and gets no workspace directory', async () => {
    const roots = join(base, 'roots');
    const app = join(roots, 'app');
    mkdirSync(join(app, 'android', 'app', 'build'), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    const old = new Date(Date.now() - 3 * day);
    for (const path of [app, join(app, 'package.json'), join(app, 'android'), join(app, 'android', 'app')])
      utimesSync(path, old, old);
    const config: Config = { maintenance: { discoverRoots: [roots] }, projects: {}, repos: {} };

    const idle = await stoppedOutputCandidates(config, reading, day);
    expect(idle.map((entry) => entry.path)).toEqual([app]);

    writeFileSync(join(app, 'App.tsx'), '');
    expect(await stoppedOutputCandidates(config, reading, day)).toEqual([]);
    expect(existsSync(join(base, 'home', 'workspaces')) ? readdirSync(join(base, 'home', 'workspaces')) : []).toEqual(
      [],
    );
  });

  it('clears the ignored build output of an idle discovered checkout and nothing else, leaving no workspace record', async () => {
    const roots = join(base, 'roots');
    const app = join(roots, 'app');
    mkdirSync(join(app, 'android', 'app', 'build'), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    writeFileSync(join(app, '.gitignore'), 'build/\n');
    writeFileSync(join(app, 'App.tsx'), 'source');
    writeFileSync(join(app, 'android', 'app', 'build', 'out.apk'), 'artifact');
    execFileSync('git', ['-C', app, 'init', '-q']);
    execFileSync('git', ['-C', app, 'add', '-A']);
    const when = new Date(Date.now() - 3 * day).toISOString();
    execFileSync('git', ['-C', app, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], {
      env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    });
    const old = new Date(Date.now() - 3 * day);
    for (const path of [app, join(app, 'android', 'app', 'build', 'out.apk'), join(app, 'android', 'app', 'build')])
      utimesSync(path, old, old);
    for (const path of [join(app, 'android', 'app'), join(app, 'android'), join(app, 'App.tsx')])
      utimesSync(path, old, old);
    for (const name of ['package.json', '.gitignore']) utimesSync(join(app, name), old, old);
    for (const name of ['index', 'HEAD', join('logs', 'HEAD')]) utimesSync(join(app, '.git', name), old, old);
    const config: Config = { maintenance: { discoverRoots: [roots] }, projects: {}, repos: {} };
    const projectsBefore = JSON.stringify(loadConfig()?.projects ?? {});

    const candidates = await stoppedOutputCandidates(config, reading, day);
    expect(candidates.map((entry) => entry.path)).toEqual([app]);
    expect(await clearStoppedOutputs(candidates[0] ?? fail(), config, day)).toMatchObject({ outcome: 'done' });

    expect(existsSync(join(app, 'android', 'app', 'build'))).toBe(false);
    expect(existsSync(join(app, 'App.tsx'))).toBe(true);
    expect(JSON.stringify(loadConfig()?.projects ?? {})).toBe(projectsBefore);
    expect(existsSync(join(base, 'home', 'workspaces')) ? readdirSync(join(base, 'home', 'workspaces')) : []).toEqual(
      [],
    );
  });

  it('clears a Cargo target with CACHEDIR.TAG at a monorepo root and the node_modules of a linked worktree, recording nothing', async () => {
    const roots = join(base, 'roots');
    const mono = join(roots, 'mono');
    mkdirSync(join(mono, 'apps', 'web'), { recursive: true });
    writeFileSync(join(mono, 'apps', 'web', 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    writeFileSync(join(mono, 'package.json'), JSON.stringify({ private: true }));
    mkdirSync(join(mono, 'target', 'debug'), { recursive: true });
    writeFileSync(join(mono, 'target', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
    writeFileSync(join(mono, '.gitignore'), 'target/\nnode_modules/\n');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
      });
    git(mono, 'init', '-q', '-b', 'main');
    git(mono, 'add', '-A');
    git(mono, 'commit', '-q', '-m', 'init');
    const linked = join(roots, 'mono-wt');
    git(mono, 'worktree', 'add', '-q', '-b', 'feature', linked);
    mkdirSync(join(linked, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(linked, 'node_modules', 'dep', 'index.js'), 'x');
    const old = new Date(Date.now() - 3 * day);
    const age = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git' && entry.isDirectory()) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) age(path);
        utimesSync(path, old, old);
      }
      utimesSync(dir, old, old);
    };
    age(mono);
    age(linked);
    for (const dir of [join(mono, '.git'), join(mono, '.git', 'worktrees', 'mono-wt')])
      for (const name of ['index', 'HEAD', join('logs', 'HEAD')])
        if (existsSync(join(dir, name))) utimesSync(join(dir, name), old, old);
    const config: Config = { maintenance: { discoverRoots: [roots] }, projects: {}, repos: {} };

    saveConfig(config);
    const candidates = await stoppedOutputCandidates(config, reading, day);
    expect(candidates.map((entry) => entry.path)).toEqual([mono]);
    const target = candidates.find((entry) => entry.path === mono) ?? fail();
    expect(await clearStoppedOutputs(target, config, day)).toMatchObject({ outcome: 'done' });
    expect(existsSync(join(mono, 'target'))).toBe(false);

    const actions = await runDormantDependencies({
      config,
      act: true,
      log: () => {},
      ...reading,
      operation: testContext(),
      force: true,
    });
    expect(actions).toContainEqual(expect.objectContaining({ kind: 'delete-dependencies', outcome: 'done' }));
    expect(existsSync(join(linked, 'node_modules'))).toBe(false);
    expect(existsSync(join(base, 'home', 'workspaces')) ? readdirSync(join(base, 'home', 'workspaces')) : []).toEqual(
      [],
    );
  });
});
