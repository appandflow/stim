import { appendFileSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNdjsonTail, readNdjsonGenerations, type NdjsonRecord } from '../ndjson.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-ndjson-tail-'));
  file = join(dir, 'device.ndjson');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const line = (n: number) => `${JSON.stringify({ ts: n, src: 'device', msg: `record ${n}` })}\n`;
const stamps = (records: NdjsonRecord[]) => records.map((record) => record.ts);

function expectSameAsFullRead(read: () => NdjsonRecord[]): void {
  expect(read()).toEqual(readNdjsonGenerations(file));
}

describe('createNdjsonTail yields the records a full read does', () => {
  test('a rotation with no new file yet, then the new file, loses nothing', () => {
    const read = createNdjsonTail(file);
    appendFileSync(file, line(1));
    expectSameAsFullRead(read);
    renameSync(file, `${file}.1`);
    expectSameAsFullRead(read);
    appendFileSync(file, line(2));
    expectSameAsFullRead(read);
    expect(stamps(read())).toEqual([1, 2]);
  });
});
