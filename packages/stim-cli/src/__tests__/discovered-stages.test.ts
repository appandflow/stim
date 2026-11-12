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
import { clearStoppedOutputs, stoppedOutputCandidates } from '../daemon/stages.ts';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../workspace/config.ts';

const fail = (): never => {
  throw new Error('no candidate');
};

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
});
