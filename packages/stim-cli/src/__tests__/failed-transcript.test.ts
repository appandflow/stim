import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retainFailedTranscript } from '../engine/failed-transcript.ts';
import { createNdjsonWriter } from '../ndjson.ts';

describe('retainFailedTranscript', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stim-failed-transcript-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('the copy survives the next build starting its log over', () => {
    const log = join(dir, 'build-artifact-ios.ndjson');
    const first = createNdjsonWriter(log, { truncate: true });
    first.write({ msg: 'the failing build' });
    first.close();

    const kept = retainFailedTranscript(log);

    const next = createNdjsonWriter(log, { truncate: true });
    next.write({ msg: 'the next build' });
    next.close();

    expect(kept.endsWith('.ndjson')).toBe(false);
    expect(readFileSync(kept, 'utf-8')).toContain('the failing build');
    expect(readFileSync(log, 'utf-8')).not.toContain('the failing build');
  });

  test('points at the log itself when it cannot copy', () => {
    const missing = join(dir, 'absent.ndjson');
    expect(retainFailedTranscript(missing)).toBe(missing);
  });
});
