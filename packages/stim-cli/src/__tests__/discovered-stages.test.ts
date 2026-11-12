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
import { stoppedOutputCandidates } from '../daemon/stages.ts';

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
});
