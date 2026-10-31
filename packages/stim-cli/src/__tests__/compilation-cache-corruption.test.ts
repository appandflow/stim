import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maintenanceNdjsonFile, sharedCompilationCache, workspaceLogsDir } from '@stim-cli/core/state';
import { register } from '../cache/cache-manifest.ts';
import { clearCorruptCompilationCache } from '../cache/compilation-cache-corruption.ts';
import { buildLockPath } from '../engine/build-lock.ts';
import { captureProcessToken } from '../process-identity.ts';
import { plantClaim } from './_factories.ts';

const LINE = 'LLVM ERROR: OnDiskCAS: corrupt internal reference';

let home: string;
let project: string;
let cas: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-cas-corrupt-')));
  project = join(home, 'project');
  mkdirSync(project);
  process.env.STIM_HOME = home;
  cas = sharedCompilationCache();
  mkdirSync(join(cas, 'v1.1'), { recursive: true });
  writeFileSync(join(cas, 'v1.1', 'index.v1'), 'x');
  register({ dir: cas, name: 'Xcode compilation cache', prune: 'atomic' });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

const records = (file: string) =>
  readFileSync(file, 'utf-8')
    .trim()
    .split('\n')
    .map((line): unknown => JSON.parse(line));

const liveParent = () => {
  const processToken = captureProcessToken(process.ppid);
  if (!processToken) throw new Error('this platform returned no process identity token');
  return { pid: process.ppid, processToken };
};

test('a corrupt cache is emptied and the build fails asking for a rerun, recorded in the maintenance log', async () => {
  plantClaim(buildLockPath('ios', 'other'), 'exclusive', liveParent(), { details: { projectRoot: '/elsewhere' } });
  const result = await clearCorruptCompilationCache({ dir: cas, line: LINE }, project);
  expect(result.code).toBe('STIM_COMPILATION_CACHE_CORRUPT');
  expect(result.message).toContain('Stim emptied it');
  expect(result.remedy).toContain('Run the same command again');
  expect(readdirSync(cas)).toEqual([]);
  for (const file of [maintenanceNdjsonFile(), join(workspaceLogsDir(project), 'maintenance.ndjson')]) {
    expect(records(file)).toEqual([
      expect.objectContaining({ event: 'maintenance_action', target: cas, reason: LINE, trigger: 'ios build' }),
    ]);
  }
});

test('a cache path Stim never registered is left alone', async () => {
  const other = join(home, 'elsewhere');
  mkdirSync(other);
  writeFileSync(join(other, 'keep'), 'x');
  const result = await clearCorruptCompilationCache({ dir: other, line: LINE }, project);
  expect(result.message).toContain('Stim did not empty it');
  expect(readdirSync(other)).toEqual(['keep']);
});
