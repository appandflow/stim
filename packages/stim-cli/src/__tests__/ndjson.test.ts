import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNdjsonText, createNdjsonWriter } from '../ndjson.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-ndjson-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createNdjsonWriter', () => {
  test.skipIf(process.platform === 'win32')('a new log and a wider logs directory end up owner-only', () => {
    const logs = join(dir, 'logs');
    mkdirSync(logs, { mode: 0o755 });
    chmodSync(logs, 0o755);
    const file = join(logs, 'metro.ndjson');
    const w = createNdjsonWriter(file);
    expect(w.write({ src: 'metro', level: 'info', msg: 'hello' })).toBe(true);
    w.close();
    expect(statSync(logs).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('exposes the running drop count without closing', () => {
    const blocker = join(dir, 'logs');
    writeFileSync(blocker, 'file');
    const w = createNdjsonWriter(join(blocker, 'metro.ndjson'));
    w.write({ src: 'metro', level: 'error', msg: 'boom' });
    expect(w.dropped).toBe(1);
    expect(w.written).toBe(0);
    w.close();
  });

  test('drops an unserializable record instead of throwing', () => {
    const file = join(dir, 'metro.ndjson');
    const w = createNdjsonWriter(file);
    const circular: Record<string, unknown> = { src: 'metro', level: 'info', msg: 'loop' };
    circular.self = circular;
    expect(w.write(circular)).toBe(false);
    w.write({ src: 'metro', level: 'info', msg: 'fine' });
    const stats = w.close();
    expect(stats.written).toBe(1);
    expect(stats.dropped).toBe(1);
    expect(parseNdjsonText(readFileSync(file, 'utf-8')).map((r) => r.msg)).toEqual(['fine']);
  });
});
