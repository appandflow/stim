import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNdjsonTail, createNdjsonWriter, readNdjsonGenerations, type NdjsonRecord } from '../ndjson.ts';

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
  test('an absent log reads as empty, and records appear as the file is created and grows', () => {
    const read = createNdjsonTail(file);
    expect(read()).toEqual([]);
    appendFileSync(file, line(1));
    expectSameAsFullRead(read);
    appendFileSync(file, line(2) + line(3));
    expectSameAsFullRead(read);
    expect(stamps(read())).toEqual([1, 2, 3]);
  });

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

  test('a rotation between two reads keeps what was written to the old file just before it', () => {
    const read = createNdjsonTail(file);
    appendFileSync(file, line(1) + line(2));
    expectSameAsFullRead(read);
    appendFileSync(file, line(3));
    renameSync(file, `${file}.1`);
    expectSameAsFullRead(read);
    expect(stamps(read())).toEqual([1, 2, 3]);
    appendFileSync(file, line(4));
    expectSameAsFullRead(read);
    expect(stamps(read())).toEqual([1, 2, 3, 4]);
  });

  test('a writer that still appends to the rotated generation after the rotation is followed', () => {
    const read = createNdjsonTail(file);
    appendFileSync(file, line(1));
    expectSameAsFullRead(read);
    renameSync(file, `${file}.1`);
    appendFileSync(file, line(2));
    expectSameAsFullRead(read);
    appendFileSync(`${file}.1`, line(3));
    expectSameAsFullRead(read);
    expect(stamps(read())).toEqual([1, 3, 2]);
  });

  test('a rotation over an existing rotated generation drops that generation before the new file appears', () => {
    const read = createNdjsonTail(file);
    writeFileSync(`${file}.1`, line(1));
    appendFileSync(file, line(2));
    expectSameAsFullRead(read);
    renameSync(file, `${file}.1`);
    expectSameAsFullRead(read);
    expect(stamps(read())).toEqual([2]);
  });

  test('two rotations between reads read both generations again', () => {
    const read = createNdjsonTail(file);
    appendFileSync(file, line(1));
    expectSameAsFullRead(read);
    renameSync(file, `${file}.1`);
    appendFileSync(file, line(2));
    renameSync(file, `${file}.1`);
    appendFileSync(file, line(3));
    expectSameAsFullRead(read);
    expect(stamps(read())).toEqual([2, 3]);
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

  test('a file deleted and recreated is read again', () => {
    const read = createNdjsonTail(file);
    appendFileSync(file, line(1) + line(2));
    expectSameAsFullRead(read);
    rmSync(file);
    expectSameAsFullRead(read);
    writeFileSync(file, line(7) + line(8) + line(9));
    expectSameAsFullRead(read);
    expect(stamps(read())).toEqual([7, 8, 9]);
  });

  test('interleaved reads and real writer rotations always match a full read', () => {
    const writer = createNdjsonWriter(file, { maxBytes: 600, now: () => 0 });
    const read = createNdjsonTail(file);
    let seed = 12345;
    const next = (limit: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % limit;
    };
    let written = 0;
    for (let step = 0; step < 300; step++) {
      for (let i = next(7); i > 0; i--) {
        writer.write({ ts: written, src: 'device', msg: `record ${written}` });
        written += 1;
      }
      expectSameAsFullRead(read);
    }
    writer.close();
    expect(written).toBeGreaterThan(300);
    expectSameAsFullRead(read);
  });

  test('a replacement file that reuses the inode number and is not shorter is read again', () => {
    const read = createNdjsonTail(file);
    appendFileSync(file, line(1) + line(2));
    expectSameAsFullRead(read);
    writeFileSync(file, line(5) + line(6) + line(7), { flag: 'r+' });
    expectSameAsFullRead(read);
    expect(stamps(read())).toEqual([5, 6, 7]);
  });

  test('reads only what was appended since the last read', () => {
    const read = createNdjsonTail(file);
    const long = `${JSON.stringify({ ts: 1000, src: 'device', msg: 'x'.repeat(100) })}\n`;
    appendFileSync(file, long);
    expect(stamps(read())).toEqual([1000]);
    const fd = openSync(file, 'r+');
    writeSync(fd, 'y', 80);
    closeSync(fd);
    appendFileSync(file, line(3000));
    expect(stamps(read())).toEqual([1000, 3000]);
    expect(String(read()[0]?.msg)).toBe('x'.repeat(100));
  });
});
