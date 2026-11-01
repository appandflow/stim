import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  test('a half-written line is held back until its newline arrives', () => {
    const read = createNdjsonTail(file);
    const whole = line(2);
    appendFileSync(file, line(1) + whole.slice(0, 10));
    expect(stamps(read())).toEqual([1]);
    appendFileSync(file, whole.slice(10, -1));
    expect(stamps(read())).toEqual([1]);
    appendFileSync(file, '\n');
    expect(stamps(read())).toEqual([1, 2]);
    expectSameAsFullRead(read);
  });

  test('a multi-byte character split across two reads is decoded whole', () => {
    const read = createNdjsonTail(file);
    const msg = `caf${String.fromCharCode(0xe9)} ${String.fromCharCode(0x2713)}`;
    const bytes = Buffer.from(`${JSON.stringify({ ts: 1, msg })}\n`);
    const cut = bytes.indexOf(0xc3) + 1;
    appendFileSync(file, bytes.subarray(0, cut));
    expect(read()).toEqual([]);
    appendFileSync(file, bytes.subarray(cut));
    expect(read()).toEqual([{ ts: 1, msg }]);
  });

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

  test('a file truncated and rewritten shorter is read again from its start', () => {
    const read = createNdjsonTail(file);
    appendFileSync(file, line(1) + line(2) + line(3));
    expectSameAsFullRead(read);
    writeFileSync(file, line(9));
    expectSameAsFullRead(read);
    expect(stamps(read())).toEqual([9]);
    appendFileSync(file, line(10));
    expect(stamps(read())).toEqual([9, 10]);
  });
});
