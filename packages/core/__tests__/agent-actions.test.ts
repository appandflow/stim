import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentActionReader, createAsyncAgentActionReader } from '../state/agent-actions.ts';

const inode = vi.hoisted(() => ({ value: null as bigint | null }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    fstatSync: (...args: Parameters<typeof fs.fstatSync>) => {
      const stat = fs.fstatSync(...args);
      return inode.value === null
        ? stat
        : { ...stat, ino: typeof stat.ino === 'bigint' ? inode.value : Number(inode.value) };
    },
  };
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-archived-actions-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  inode.value = null;
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test.each([createAgentActionReader, createAsyncAgentActionReader])(
  'archived sessions retain actions and request starts without live device claims (%#)',
  async (createReader) => {
    const sessionsDir = join(home, 'archive', 'removed', 'agent-device', 'sessions');
    const read = createReader({ sessionsDirs: [sessionsDir] });
    expect(await read()).toEqual([]);
    cpSync(join(import.meta.dirname, '../../stim-cli/src/__tests__/fixtures/agent-device/sessions'), sessionsDir, {
      recursive: true,
    });
    const records = await read();
    expect(records).toHaveLength(11);
    expect(records).toContainEqual(
      expect.objectContaining({
        src: 'agent',
        event: 'agent_action',
        platform: 'ios',
        deviceId: 'AD45387C-599D-4EDB-A62B-18176FF3A2A7',
        command: 'press',
        msg: 'Tapped (201, 542)',
        ts: Date.parse('2026-09-25T12:16:03.448Z'),
        startedAt: Date.parse('2026-09-25T12:15:57.453Z'),
      }),
    );
    const android = records.find((record) => record.msg === 'Failed open: DEVICE_NOT_FOUND');
    expect(android).toMatchObject({
      src: 'agent',
      event: 'agent_failed',
      level: 'error',
      platform: 'android',
      command: 'open',
      session: 'and5012',
      startedAt: Date.parse('2026-09-13T01:56:45.575Z'),
    });
    expect(android).not.toHaveProperty('deviceId');
    expect(await read()).toEqual([]);
  },
);

test('async agent reads can be cancelled while parsing a large session', async () => {
  const sessionsDir = join(home, 'sessions');
  const dir = join(sessionsDir, 'large');
  mkdirSync(dir, { recursive: true });
  const event = {
    version: 1,
    ts: '2026-10-11T00:00:00Z',
    session: 'large',
    kind: 'action.recorded',
    command: 'press',
    summary: 'tap',
    details: { platform: 'android' },
  };
  writeFileSync(join(dir, 'events.ndjson'), (JSON.stringify(event) + '\n').repeat(30_000));
  const abort = new AbortController();
  const read = createAsyncAgentActionReader({ sessionsDirs: [sessionsDir] }, abort.signal);
  const pending = read();
  setImmediate(() => abort.abort(new Error('cancel actions')));
  await expect(pending).rejects.toThrow('cancel actions');
});
