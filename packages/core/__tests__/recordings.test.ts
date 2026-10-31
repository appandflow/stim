import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRecordedDevicesAsync, recordingEnabled } from '../state/recordings.ts';

const recordingIo = vi.hoisted((): { afterStat?: () => void } => ({}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    stat: async (...args: Parameters<typeof fs.stat>) => {
      const metadata = await fs.stat(...args);
      recordingIo.afterStat?.();
      return metadata;
    },
  };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-recordings-'));
});

afterEach(() => {
  recordingIo.afterStat = undefined;
  rmSync(dir, { recursive: true, force: true });
});

test('a cancellation during a segment stat propagates through the device scan', async () => {
  const ios = join(dir, 'ios-default');
  mkdirSync(ios);
  writeFileSync(join(ios, '1000-4000.seg'), 'abc');
  const controller = new AbortController();
  const reason = new Error('recording scan cancelled');
  recordingIo.afterStat = () => controller.abort(reason);
  await expect(listRecordedDevicesAsync(dir, false, controller.signal)).rejects.toBe(reason);
});

test('STIM_RECORDING wins over the workspace, repo and machine layers, which win in that order', () => {
  const off = { recording: { enabled: false } };
  const on = { recording: { enabled: true } };

  expect(recordingEnabled({}, [])).toBe(true);
  expect(recordingEnabled({}, [undefined, off, on])).toBe(false);
  expect(recordingEnabled({}, [on, off, off])).toBe(true);
  expect(recordingEnabled({ STIM_RECORDING: '0' }, [on])).toBe(false);
  expect(recordingEnabled({ STIM_RECORDING: 'true' }, [off])).toBe(true);
  expect(recordingEnabled({ STIM_RECORDING: 'nope' }, [off])).toBe(false);
});
