import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOSTED_LOGS_FIRST_BYTES,
  HOSTED_LOGS_PAGE_BYTES,
  readLogsSince,
  type HostedLogsCursor,
} from '../state/hosted-logs.ts';

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'stim-hosted-logs-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const line = (n: number, pad = 0) => `${JSON.stringify({ ts: n, msg: `line ${n}`, pad: 'x'.repeat(pad) })}\n`;

function drain(cursor: HostedLogsCursor = {}): { ns: number[]; pages: number } {
  const ns: number[] = [];
  let pages = 0;
  for (;;) {
    const page = readLogsSince(dir, cursor);
    pages += 1;
    ns.push(...page.records.map((record) => record.ts as number));
    cursor = page.cursor;
    if (!page.more) return { ns, pages };
  }
}

test('pages through a log larger than one page without losing or repeating a record', () => {
  const total = 3000;
  writeFileSync(join(dir, 'macos.ndjson'), Array.from({ length: total }, (_, n) => line(n, 1000)).join(''));
  const { ns, pages } = drain();
  expect(pages).toBeGreaterThan(Math.ceil((total * 1000) / HOSTED_LOGS_PAGE_BYTES) - 1);
  expect(ns).toEqual(Array.from({ length: total }, (_, n) => n));
});

test('a first read of a huge log starts at a whole line near its end', () => {
  const size = Math.ceil((HOSTED_LOGS_FIRST_BYTES * 1.5) / 1000);
  writeFileSync(join(dir, 'macos.ndjson'), Array.from({ length: size }, (_, n) => line(n, 1000)).join(''));
  const { ns } = drain();
  expect(ns.at(-1)).toBe(size - 1);
  expect(ns[0]).toBeGreaterThan(size - HOSTED_LOGS_FIRST_BYTES / 900);
  expect(ns).toEqual(Array.from({ length: ns.length }, (_, n) => ns[0]! + n));
});
