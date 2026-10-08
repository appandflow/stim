import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createNdjsonWriter } from '../ndjson.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-ndjson-run-'));
});
afterEach(() => {
  delete process.env.STIM_RUN_ID;
  rmSync(dir, { recursive: true, force: true });
});

test('every record a writer appends carries the run id, and a record that has one keeps it', () => {
  const writer = createNdjsonWriter(join(dir, 'build.ndjson'));
  writer.write({ src: 'build', msg: 'one' });
  writer.write({ src: 'build', msg: 'two', runId: 'inherited', ts: 5 });
  writer.close();
  const [one, two] = readFileSync(join(dir, 'build.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(one.runId).toMatch(/^[a-f0-9]{12}$/);
  expect(two).toMatchObject({ runId: 'inherited', ts: 5 });
  expect(process.env.STIM_RUN_ID).toBe(one.runId);
});
