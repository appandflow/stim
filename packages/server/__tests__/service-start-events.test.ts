import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { serviceManagerOrNull } from '../src/service-manager.ts';
import { renderTask } from '../src/service-task.ts';

const fixture = vi.hoisted(() => {
  const observers: {
    changed(event: string, filename: string | null): void;
    close(): void;
    emit(event: string, error: Error): boolean;
    closed: boolean;
  }[] = [];
  return { enginePid: 73, checks: 0, observers };
});

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: (
    file: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    if (file === 'powershell.exe') fixture.checks += 1;
    callback(
      null,
      file === 'whoami' ? '"fixture","S-1-5-21-123"' : file === 'powershell.exe' ? String(fixture.enginePid) : '',
      '',
    );
  },
}));

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    copyFileSync: (source: string, destination: string) => {
      if (source.endsWith('stim-service-runner.mjs')) fs.writeFileSync(destination, 'fixture');
      else fs.copyFileSync(source, destination);
    },
    watch: (_file: string, _options: unknown, changed: (event: string, filename: string | null) => void) => {
      const watcher = Object.assign(new EventEmitter(), {
        changed,
        closed: false,
        close() {
          this.closed = true;
        },
      });
      fixture.observers.push(watcher);
      return watcher;
    },
  };
});

const selected = serviceManagerOrNull('win32');
assert(selected);
const manager = selected;
const label = 'dev.stim.registration-test';
let scratch: string;

beforeEach(() => {
  vi.useFakeTimers();
  scratch = mkdtempSync(join(tmpdir(), 'stim-service-registration-'));
  vi.stubEnv('LOCALAPPDATA', scratch);
  fixture.enginePid = 73;
  fixture.checks = 0;
  fixture.observers = [];
  mkdirSync(dirname(manager.file(label)), { recursive: true });
  writeFileSync(
    manager.file(label),
    renderTask({
      label,
      host: null,
      node: process.execPath,
      script: join(scratch, 'server.mjs'),
      port: 7787,
      env: [],
      pathPrepend: [],
      environment: {},
      logPath: manager.logPath(label),
      workingDirectory: scratch,
      serve: null,
    }),
  );
});

afterEach(() => {
  vi.clearAllTimers();
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

function record(pid = fixture.enginePid) {
  writeFileSync(join(manager.root(label), 'supervisor.json'), JSON.stringify({ supervisor: pid, server: 74, runs: 1 }));
}

function emitRegistration() {
  for (const observer of fixture.observers) observer.changed('rename', 'supervisor.json');
}

test('a registration hint wakes validation before polling, without trusting a mismatched TaskScheduler PID', async () => {
  let finished = false;
  const pending = manager.start(label).then((result) => {
    finished = true;
    return result;
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(fixture.checks).toBe(1);
    record(99);
    emitRegistration();
    await vi.advanceTimersByTimeAsync(1);
    expect(finished).toBe(false);
    record();
    emitRegistration();
    await vi.advanceTimersByTimeAsync(1);
    expect(finished).toBe(true);
    expect(fixture.observers.every((observer) => observer.closed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).ok).toBe(true);
  }
});

test('watcher failure wakes validation and falls back without leaking its observer', async () => {
  const pending = manager.start(label);
  await vi.advanceTimersByTimeAsync(0);
  const observer = fixture.observers[0];
  assert(observer);
  observer.emit('error', new Error('fixture watch failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(observer.closed).toBe(true);
  record();
  await vi.advanceTimersByTimeAsync(250);
  expect((await pending).ok).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
