import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-run-id-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const debugRecords = (env: Record<string, string>) => {
  const cli = new URL('../../bin/cli.ts', import.meta.url).pathname;
  spawnSync(process.execPath, [cli, 'ports'], {
    env: { ...process.env, STIM_HOME: home, STIM_DEBUG: '1', STIM_RUN_ID: '', ...env },
    stdio: 'ignore',
  });
  return readFileSync(join(home, 'logs', 'debug', 'cli.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { runId: string });
};

test('a run takes the id Desktop passes in STIM_RUN_ID and stamps every record with it', () => {
  const records = debugRecords({ STIM_RUN_ID: 'desktop-abc.1' });
  expect(records.length).toBeGreaterThan(1);
  expect(new Set(records.map((record) => record.runId))).toEqual(new Set(['desktop-abc.1']));
});

test('without a valid STIM_RUN_ID a run generates its own', () => {
  for (const given of ['', 'bad id;']) {
    const ids = new Set(debugRecords({ STIM_RUN_ID: given }).map((record) => record.runId));
    expect([...ids]).toHaveLength(1);
    expect(ids.values().next().value).toMatch(/^[a-f0-9]{12}$/);
    rmSync(join(home, 'logs'), { recursive: true, force: true });
  }
});
