import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { getExecutor, resetExecutor } from '../exec.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-exec-trace-'));
  file = join(dir, 'trace.json');
  process.env.STIM_TRACE = file;
  resetExecutor();
});
afterEach(() => {
  delete process.env.STIM_TRACE;
  delete process.env.STIM_TRACE_OWNER;
  rmSync(dir, { recursive: true, force: true });
});

interface Span {
  name: string;
  cat?: string;
  tid?: number;
  ts?: number;
  dur?: number;
  args?: { argv?: string[]; command?: string; ok?: boolean; exit?: number; spawned?: boolean };
}

const spans = (): Span[] => {
  const events: Span[] = JSON.parse(`${readFileSync(file, 'utf8').trimEnd().replace(/,$/, '')}]`);
  return events.filter((event) => event.cat === 'exec');
};

test('every executor entry point writes one span per child, with secrets in arguments redacted', async () => {
  const executor = getExecutor();
  const node = process.execPath;
  executor.runFile(node, ['-e', '0', '--', '--api-token', 'sync-secret', 'plain-arg'], { timeoutMs: 60_000 });
  await executor.runFileAsync(node, ['-e', '0', '--', '--password=async-secret', 'exact-secret'], {
    timeoutMs: 60_000,
    redact: ['exact-secret'],
  });
  executor.run(`${JSON.stringify(node)} -e 0 -- --token shell-secret`, { timeoutMs: 60_000 });
  await new Promise<void>((resolve) => {
    executor.spawn(node, ['-e', '0', '--', '--token=spawn-secret']).once('close', () => resolve());
  });
  expect(() => executor.runFile(node, ['-e', 'process.exit(3)'], { timeoutMs: 60_000 })).toThrow('Command failed');

  const text = readFileSync(file, 'utf8');
  expect(text).not.toMatch(/sync-secret|async-secret|shell-secret|spawn-secret|exact-secret/);
  expect(spans()).toMatchObject([
    { name: 'node', args: { ok: true, argv: [node, '-e', '0', '--', '--api-token', '[redacted]', 'plain-arg'] } },
    { args: { argv: [node, '-e', '0', '--', '--password=[redacted]', '***'] } },
    { name: 'node', args: { command: expect.stringContaining('--token [redacted]') } },
    { args: { spawned: true, ok: true, argv: [node, '-e', '0', '--', '--token=[redacted]'] } },
    { args: { ok: false, exit: 3 } },
  ]);
});

test.skipIf(process.platform === 'win32')('the program name selects the flags that carry a credential', () => {
  const curl = join(dir, 'curl');
  writeFileSync(curl, '#!/bin/sh\nexit 0\n');
  chmodSync(curl, 0o755);
  getExecutor().runFile(curl, ['-u', 'user:curl-secret', 'https://example.com'], { timeoutMs: 60_000 });
  expect(readFileSync(file, 'utf8')).not.toContain('curl-secret');
  expect(spans()).toMatchObject([{ args: { argv: [curl, '-u', '[redacted]', 'https://example.com'] } }]);
});

test('children running at the same time get separate lanes so their spans do not overlap on one track', async () => {
  const executor = getExecutor();
  await Promise.all([
    executor.runFileAsync(process.execPath, ['-e', 'setTimeout(()=>{},300)'], { timeoutMs: 60_000 }),
    executor.runFileAsync(process.execPath, ['-e', 'setTimeout(()=>{},300)'], { timeoutMs: 60_000 }),
  ]);
  const [a, b] = spans();
  expect(a?.tid).not.toBe(b?.tid);
  expect(a?.tid).toBeDefined();
});
