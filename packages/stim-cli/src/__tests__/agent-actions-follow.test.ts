import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NdjsonRecord } from '@stim-cli/core/state';
import { followAgentActions } from '../devices/agent-actions-follow.ts';

const watches = vi.hoisted(() => ({
  callbacks: new Map<string, (event: 'change' | 'rename', name: string | null) => void>(),
  opened: new Set<object>(),
  closed: new Set<object>(),
}));

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  const { EventEmitter } = await import('node:events');
  return {
    ...fs,
    watch: (path: string, _options: unknown, callback: (event: 'change' | 'rename', name: string | null) => void) => {
      const watcher = new (class extends EventEmitter {
        close() {
          watches.closed.add(this);
          this.emit('close');
        }
      })();
      watches.opened.add(watcher);
      watches.callbacks.set(path, callback);
      watcher.once('close', () => {
        if (watches.callbacks.get(path) === callback) watches.callbacks.delete(path);
      });
      return watcher;
    },
  };
});

let home: string;
let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  home = mkdtempSync(join(tmpdir(), 'stim-agent-follow-'));
  watches.callbacks.clear();
  watches.opened.clear();
  watches.closed.clear();
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
});

function fixture(missing = false) {
  const root = join(home, '.agent-device');
  const claims = join(root, 'device-claims');
  const stimHome = join(home, 'stim');
  const workspaces = join(stimHome, 'workspaces');
  mkdirSync(workspaces, { recursive: true });
  if (!missing) mkdirSync(claims, { recursive: true });
  const abort = new AbortController();
  const pending: NdjsonRecord[] = [];
  const output: NdjsonRecord[] = [];
  const read = vi.fn<() => Promise<NdjsonRecord[]>>(async () => pending.splice(0));
  stop = followAgentActions({ home: stimHome, env: { HOME: home }, signal: abort.signal }, read, (record) => {
    output.push(record);
  });
  return { root, claims, workspaces, abort, pending, output, read };
}

const record = (msg: string): NdjsonRecord => ({ ts: 1, src: 'agent', level: 'info', msg });

test('startup and dropped-event repair deliver actions without twice-a-second idle reads', async () => {
  const state = fixture();
  state.pending.push(record('startup gap'));
  await vi.advanceTimersByTimeAsync(500);
  expect(state.output.map((item) => item.msg)).toEqual(['startup gap']);
  state.read.mockClear();
  await vi.advanceTimersByTimeAsync(5000);
  expect(state.read).not.toHaveBeenCalled();
  state.pending.push(record('missed notification'));
  await vi.advanceTimersByTimeAsync(5000);
  expect(state.output.map((item) => item.msg)).toEqual(['startup gap', 'missed notification']);
  expect(state.read).toHaveBeenCalledTimes(1);
});

test('file bursts, claims and workspace action changes wake the reader; unrelated state writes do not', async () => {
  const state = fixture();
  await vi.advanceTimersByTimeAsync(500);
  state.read.mockClear();
  state.pending.push(record('action'));
  for (let i = 0; i < 20; i++) watches.callbacks.get(state.root)?.('change', 'sessions/demo/events.ndjson');
  await vi.advanceTimersByTimeAsync(500);
  expect(state.read).toHaveBeenCalledTimes(1);
  state.pending.push(record('new claim'));
  watches.callbacks.get(state.claims)?.('rename', 'claim.json');
  await vi.advanceTimersByTimeAsync(500);
  state.read.mockClear();
  watches.callbacks.get(state.workspaces)?.('change', 'workspace/state.json');
  await vi.advanceTimersByTimeAsync(500);
  expect(state.read).not.toHaveBeenCalled();
  state.pending.push(record('scoped action'));
  watches.callbacks.get(state.workspaces)?.('change', 'workspace/agent-device/sessions/demo/events.ndjson');
  await vi.advanceTimersByTimeAsync(500);
  expect(state.output.map((item) => item.msg)).toEqual(['action', 'new claim', 'scoped action']);
});

test('roots created or replaced after following starts receive new watches and actions', async () => {
  const state = fixture(true);
  await vi.advanceTimersByTimeAsync(500);
  mkdirSync(state.claims, { recursive: true });
  state.pending.push(record('new root'));
  watches.callbacks.get(home)?.('rename', '.agent-device');
  await vi.advanceTimersByTimeAsync(500);
  renameSync(state.root, join(home, 'old-agent-device'));
  mkdirSync(state.claims, { recursive: true });
  state.pending.push(record('replacement'));
  watches.callbacks.get(state.root)?.('rename', null);
  await vi.advanceTimersByTimeAsync(500);
  state.pending.push(record('replacement event'));
  watches.callbacks.get(state.root)?.('change', 'sessions/new/events.ndjson');
  await vi.advanceTimersByTimeAsync(500);
  expect(state.output.map((item) => item.msg)).toEqual(['new root', 'replacement', 'replacement event']);
  stop?.();
  expect(watches.closed.size).toBe(watches.opened.size);
});

test('abort closes watches and ignores pending reads, queued events and later repair ticks', async () => {
  const state = fixture();
  await vi.advanceTimersByTimeAsync(500);
  state.read.mockClear();
  let finish: (records: NdjsonRecord[]) => void = () => {};
  state.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const changed = watches.callbacks.get(state.root);
  changed?.('change', 'sessions/demo/events.ndjson');
  await vi.advanceTimersByTimeAsync(500);
  changed?.('change', 'sessions/demo/events.ndjson');
  await vi.advanceTimersByTimeAsync(500);
  state.abort.abort();
  finish([record('late')]);
  changed?.('change', 'sessions/demo/events.ndjson');
  await vi.advanceTimersByTimeAsync(30_000);
  expect(state.output).toEqual([]);
  expect(state.read).toHaveBeenCalledTimes(1);
  expect(watches.closed.size).toBe(watches.opened.size);
});
