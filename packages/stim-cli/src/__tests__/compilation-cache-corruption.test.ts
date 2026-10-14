import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maintenanceNdjsonFile, sharedCompilationCache, workspaceLogsDir } from '@stim-cli/core/state';
import { clearCorruptCompilationCache } from '../cache/compilation-cache-corruption.ts';
import { acquireBuildLock, buildLockPath, releaseBuildLock } from '../engine/build-lock.ts';
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

test('a corrupt cache is emptied and the build fails asking for a rerun, recorded in the maintenance log', () => {
  const own = acquireBuildLock({ platform: 'ios', key: 'k', root: project });
  try {
    const result = clearCorruptCompilationCache({ dir: cas, line: LINE }, project);
    expect(result.code).toBe('STIM_COMPILATION_CACHE_CORRUPT');
    expect(result.message).toContain('Stim emptied it');
    expect(result.remedy).toContain('Run the same command again');
  } finally {
    releaseBuildLock(own);
  }
  expect(readdirSync(cas)).toEqual([]);
  for (const file of [maintenanceNdjsonFile(), join(workspaceLogsDir(project), 'maintenance.ndjson')]) {
    expect(records(file)).toEqual([
      expect.objectContaining({ event: 'maintenance_action', target: cas, reason: LINE, trigger: 'ios build' }),
    ]);
  }
});

test.each([
  [
    'another live build holds a lock',
    () => {
      const processToken = captureProcessToken(process.ppid);
      if (!processToken) throw new Error('this platform returned no process identity token');
      return { pid: process.ppid, processToken };
    },
  ],
  ['a build lock holder cannot be identified', () => ({ pid: 4242, processToken: 'nonsense' })],
])('the cache is left alone when %s, and the error still asks for a rerun', (_name, owner) => {
  plantClaim(buildLockPath('android', 'other'), 'exclusive', owner(), { details: { projectRoot: '/elsewhere' } });
  const result = clearCorruptCompilationCache({ dir: cas, line: LINE }, project);
  expect(result.code).toBe('STIM_COMPILATION_CACHE_CORRUPT');
  expect(result.message).toContain('Stim did not empty it');
  expect(result.remedy).toContain('gc --delete --cache "compilation cache"');
  expect(result.remedy).toContain('run the same command again');
  expect(readdirSync(join(cas, 'v1.1'))).toEqual(['index.v1']);
  expect(records(maintenanceNdjsonFile())).toEqual([
    expect.objectContaining({ event: 'maintenance_failure', target: cas, blocked: expect.any(String) }),
  ]);
});
