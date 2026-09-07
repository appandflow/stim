import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { readMacosProcess } from '../macos-process.ts';
import { readProcessArgs, readProcessStartTime } from '../process-args.ts';

describe.skipIf(process.platform !== 'darwin')('native macOS process inspection', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-native-process-'));
    process.env.STIM_HOME = home;
  });
  afterEach(() => {
    resetExecutor();
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test('keeps exact argv boundaries and start identity when ps execution is denied', async () => {
    const executor = getExecutor();
    const args = ['-e', 'setInterval(() => {}, 1000)', '--', 'space and "quotes"', '', 'back\\slash', '\u2603'];
    const child = executor.spawn(process.execPath, args, { stdio: 'ignore' });
    const exited = once(child, 'exit');
    await once(child, 'spawn');
    try {
      const observation = readMacosProcess(child.pid!);
      expect(observation?.args).toEqual([process.execPath, ...args]);
      expect(observation?.zombie).toBe(false);
      expect(observation?.startTime.getTime()).toBeLessThanOrEqual(Date.now());
      expect(observation?.startTime.getTime()).toBeGreaterThan(Date.now() - 10_000);
      setExecutor({
        ...executor,
        runFile(file, argv, options) {
          if (file === 'ps') throw Object.assign(new Error('denied'), { code: 'EPERM' });
          return executor.runFile(file, argv, options);
        },
      });
      expect(readProcessArgs(child.pid!)).toEqual(observation?.args);
      expect(readProcessStartTime(child.pid!)).toEqual(observation?.startTime);
      child.kill();
      await exited;
      expect(readMacosProcess(child.pid!)).toBeNull();
      expect(readProcessArgs(child.pid!)).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
    }
  });

  test('refuses invalid PIDs without running a compiler or process query', () => {
    setExecutor({
      runFile() {
        throw new Error('must not execute');
      },
    });
    for (const pid of [0, -1, 1.1, NaN, Infinity, 2_147_483_648]) expect(readMacosProcess(pid)).toBeNull();
  });

  test('does not accept truncated, foreign-PID, oversized, or malformed native evidence', () => {
    expect(readMacosProcess(process.pid)).not.toBeNull();
    const base = {
      pid: process.pid,
      startSeconds: '1700000000',
      startMicros: 123456,
      zombie: false,
      argc: 1,
      argvHex: Buffer.from('node\0').toString('hex'),
    };
    for (const change of [
      { pid: process.pid + 1 },
      { startSeconds: 'NaN' },
      { startMicros: 1_000_000 },
      { argc: 2 },
      { argvHex: 'ff00' },
      { argvHex: 'node' },
      { argvHex: '61'.repeat(32769) },
      { zombie: true },
      { argvHex: '6e6f6465' },
    ]) {
      setExecutor({
        runFile() {
          return JSON.stringify({ ...base, ...change });
        },
      });
      expect(readMacosProcess(process.pid)).toBeNull();
    }
    setExecutor({
      runFile() {
        return '{';
      },
    });
    expect(readMacosProcess(process.pid)).toBeNull();
  });
});
