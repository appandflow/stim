import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { buildClaimRoot } from '../engine-store/claims.ts';
import { machineCopy } from './fixtures/machine-copy.ts';

const PACKAGE = fileURLToPath(new URL('../..', import.meta.url));

test.skipIf(process.platform === 'win32')(
  'the built flip wrapper runs the staged engine selector with its staged settings',
  () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stim-real-flip-')));
    const home = join(tmp, 'home');
    const root = join(tmp, 'engine');
    const work = join(tmp, 'work');
    const installed = (name: string) => join(tmp, name, 'lib', 'node_modules', 'stim');
    const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
    const env = { ...process.env, HOME: tmp, STIM_HOME: home, STIM_ENGINE_ROOT: root };
    mkdirSync(work);
    mkdirSync(home);
    writeFileSync(join(home, 'schema.json'), JSON.stringify({ schema: 1, by: 'fixture' }));
    try {
      machineCopy(PACKAGE, join(tmp, 'a'));
      cpSync(installed('a'), installed('b'), { recursive: true, verbatimSymlinks: true });
      const manifest = read(join(installed('b'), 'package.json'));
      manifest.version = `${manifest.version}-flip.1`;
      writeFileSync(join(installed('b'), 'package.json'), JSON.stringify(manifest));
      appendFileSync(join(installed('b'), 'dist', 'cli.mjs'), '\n// staged fixture\n');
      const install = spawnSync(process.execPath, [join(installed('a'), 'bin', 'stim.mjs'), 'engine', 'install'], {
        cwd: work,
        env,
        encoding: 'utf8',
      });
      expect(install.status).toBe(0);
      const a: string = read(join(root, 'current.json')).dir;
      const claim = tryAcquireClaim({
        root: buildClaimRoot(root, a),
        mode: 'shared',
        details: { drained: false },
      }).acquired;
      if (!claim) throw new Error('fixture claim unavailable');
      try {
        const stage = spawnSync(
          process.execPath,
          [
            join(installed('b'), 'dist', 'engine-select.mjs'),
            '--explicit',
            '--pin',
            'fixture pin',
            '--channel',
            'next',
            '--set-by',
            'fixture',
          ],
          { cwd: work, env, encoding: 'utf8' },
        );
        expect(stage.status).toBe(0);
        expect(JSON.parse(stage.stdout)).toHaveProperty('staged');
      } finally {
        releaseClaim(claim);
      }
      const staged = read(join(root, 'staged.json'));
      const flip = spawnSync(process.execPath, [join(root, a, 'dist', 'engine-flip.mjs')], {
        cwd: work,
        env,
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(flip.status).toBe(0);
      expect(JSON.parse(flip.stdout)).toEqual({ flipped: staged.dir });
      expect(read(join(root, 'current.json'))).toMatchObject({
        dir: staged.dir,
        pinned: true,
        pinReason: 'fixture pin',
        channel: 'next',
        setBy: 'fixture',
      });
      expect(read(join(home, 'schema.json'))).toMatchObject({ schema: 1, by: staged.version });
    } finally {
      if (process.platform !== 'win32') execFileSync('chmod', ['-R', 'u+w', tmp]);
      rmSync(tmp, { recursive: true, force: true });
    }
  },
  120_000,
);
