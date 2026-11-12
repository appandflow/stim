import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isJsonObject } from '@stim-cli/core/state';
import { macosAppLogName, macosProcess } from '../macos/state.ts';
import { inspectProcessIdentity } from '../process-identity.ts';
import { MACOS_APP_SINK, drained, tailMacosApp } from '../stimd/logs/macos-tail.ts';

const messages = (dir: string): unknown[] =>
  existsSync(join(dir, MACOS_APP_SINK))
    ? readFileSync(join(dir, MACOS_APP_SINK), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const record: unknown = JSON.parse(line);
          return isJsonObject(record) ? record.msg : undefined;
        })
    : [];

const records = (dir: string): Record<string, unknown>[] =>
  readFileSync(join(dir, MACOS_APP_SINK), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!isJsonObject(value)) throw new Error('a sink line is not a record');
      return value;
    });

const readMark = (file: string): Record<string, unknown> => {
  const mark: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isJsonObject(mark)) throw new Error('the tail mark is not an object');
  return mark;
};

const started = async (child: ReturnType<typeof spawn>): Promise<number> => {
  await once(child, 'spawn');
  if (child.pid === undefined) throw new Error('the fixture did not start');
  return child.pid;
};

describe.skipIf(process.platform !== 'darwin')('macOS app output tail', () => {
  let dir: string;
  const pids: number[] = [];
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'stim-macos-tail-')));
  });
  afterEach(() => {
    for (const pid of pids.splice(0))
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  test('a helper that left the app group and holds its output keeps the run open until it exits', async () => {
    const out = join(dir, macosAppLogName('fixture', 'out'));
    writeFileSync(out, '');
    writeFileSync(join(dir, macosAppLogName('fixture', 'err')), '');
    const script = `
      const { spawn } = require('node:child_process');
      const helper = spawn(process.execPath, ['-e', 'console.log("helper line"); setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      console.log('app line ' + helper.pid);
      setTimeout(() => process.kill(process.pid, 'SIGKILL'), 200);
    `;
    const fd = openSync(out, 'a');
    const app = spawn(process.execPath, ['-e', script], {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    const record = macosProcess(await started(app));
    const tail = tailMacosApp(dir, record, 'Fixture', 'fixture');
    if (!tail) throw new Error('the tail did not start');
    try {
      await once(app, 'exit');
      const helper = await vi.waitFor(() => {
        const line = messages(dir).find((msg) => typeof msg === 'string' && msg.startsWith('app line '));
        if (typeof line !== 'string') throw new Error('the app line was not copied');
        return Number(line.slice('app line '.length));
      });
      pids.push(helper);
      await vi.waitFor(() => expect(messages(dir)).toContain('helper line'));
      expect(await tail.drain()).toBe(false);
      expect(tail.blocked()).toContain(`pid ${helper} still holds its output open; stop it (kill ${helper})`);
      expect(drained(dir, record)).toBe(false);
      expect(existsSync(out)).toBe(true);
      process.kill(helper, 'SIGKILL');
      await vi.waitFor(async () => expect(await tail.drain()).toBe(true), {
        timeout: 5000,
      });
      expect(drained(dir, record)).toBe(true);
      expect(existsSync(out)).toBe(false);
      expect(messages(dir).filter((msg) => msg === 'helper line')).toHaveLength(1);
      expect(records(dir).at(-1)).toMatchObject({
        level: 'error',
        msg: expect.stringContaining('Fixture ended without being stopped by Stim; its exit status is unknown.'),
      });
    } finally {
      tail.close();
      if (inspectProcessIdentity(record) === 'same') process.kill(record.pid, 'SIGKILL');
    }
  }, 20_000);

  test('a tail that resumes after an interrupted append neither repeats nor skips lines', async () => {
    const out = join(dir, macosAppLogName('fixture', 'out'));
    writeFileSync(out, 'one\ntwo\n');
    writeFileSync(join(dir, macosAppLogName('fixture', 'err')), '');
    const app = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    pids.push(await started(app));
    const record = macosProcess(pids[0] ?? 0);
    const first = tailMacosApp(dir, record, 'Fixture', 'fixture');
    if (!first) throw new Error('the tail did not start');
    expect(first.ready()).toBeNull();
    first.close();
    expect(messages(dir)).toEqual(['one', 'two', 'Observing Fixture output.']);
    const mark = join(dir, 'macos-app.tail.json');
    const sink = join(dir, MACOS_APP_SINK);
    const ino = statSync(sink, { bigint: true }).ino.toString();
    const line = (msg: string) => `${JSON.stringify({ src: 'client', platform: 'macos', level: 'info', msg })}\n`;
    const inFlight = (next: Record<string, unknown>, text: string, written: string) => {
      const size = readFileSync(sink).length;
      writeFileSync(
        mark,
        JSON.stringify({
          ...readMark(mark),
          pending: { ino, size, end: size + Buffer.byteLength(text), next: { ...next, processToken: undefined } },
        }),
      );
      appendFileSync(sink, written);
    };
    const resume = () => {
      const tail = tailMacosApp(dir, record, 'Fixture', 'fixture');
      if (!tail) throw new Error('the tail did not resume');
      expect(tail.ready()).toBeNull();
      tail.close();
    };
    appendFileSync(out, 'three\n');
    inFlight({ ...readMark(mark), out: Number(readMark(mark).out) + 6 }, line('three'), line('three'));
    resume();
    expect(messages(dir)).toEqual(['one', 'two', 'Observing Fixture output.', 'three']);
    appendFileSync(out, 'four\n');
    inFlight({ ...readMark(mark), out: Number(readMark(mark).out) + 5 }, line('four'), line('four').slice(0, 20));
    resume();
    expect(messages(dir)).toEqual(['one', 'two', 'Observing Fixture output.', 'three', 'four']);
    appendFileSync(out, 'five\n');
    inFlight({ ...readMark(mark), out: Number(readMark(mark).out) + 5 }, line('five'), '');
    resume();
    expect(messages(dir)).toEqual(['one', 'two', 'Observing Fixture output.', 'three', 'four', 'five']);
    process.kill(record.pid, 'SIGKILL');
    await vi.waitFor(() => expect(inspectProcessIdentity(record)).not.toBe('same'));
    inFlight({ ...readMark(mark), exited: true }, line('Exited Fixture.'), line('Exited Fixture.'));
    const finished = tailMacosApp(dir, record, 'Fixture', 'fixture');
    if (!finished) throw new Error('the tail did not resume');
    expect(await finished.drain()).toBe(true);
    expect(messages(dir).filter((msg) => msg === 'Exited Fixture.')).toHaveLength(1);
    expect(existsSync(out)).toBe(false);
    expect(drained(dir, record)).toBe(true);
  });

  test('an end Stim requested is an info exit record', async () => {
    writeFileSync(join(dir, macosAppLogName('fixture', 'out')), '');
    writeFileSync(join(dir, macosAppLogName('fixture', 'err')), '');
    const app = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    pids.push(await started(app));
    const record = macosProcess(pids[0] ?? 0);
    const tail = tailMacosApp(dir, record, 'Fixture', 'fixture');
    if (!tail) throw new Error('the tail did not start');
    try {
      writeFileSync(join(dir, macosAppLogName('fixture', 'stop')), '');
      process.kill(record.pid, 'SIGTERM');
      await vi.waitFor(() => expect(inspectProcessIdentity(record)).not.toBe('same'));
      await vi.waitFor(async () => expect(await tail.drain()).toBe(true));
      expect(records(dir).at(-1)).toMatchObject({ level: 'info', msg: 'Exited Fixture.' });
      expect(existsSync(join(dir, macosAppLogName('fixture', 'stop')))).toBe(false);
    } finally {
      tail.close();
    }
  });
});
