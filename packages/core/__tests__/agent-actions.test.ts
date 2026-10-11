import { appendFileSync, cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

test('rotation drops old app attribution when distinct 64-bit file IDs round to the same Number', () => {
  const sessionsDir = join(home, 'sessions');
  const dir = join(sessionsDir, 'native');
  mkdirSync(dir, { recursive: true });
  const events = join(dir, 'events.ndjson');
  const launchedAt = Date.parse('2026-09-25T12:15:00Z');
  const event = (seconds: number, command: string, details = {}) => ({
    version: 1,
    ts: new Date(launchedAt + seconds * 1000).toISOString(),
    session: 'native',
    kind: 'action.recorded',
    command,
    summary: command,
    details,
  });
  const open = (seconds: number, appBundleId = 'dev.owned') =>
    event(seconds, 'open', { platform: 'macos', appBundleId, flags: { surface: 'app' } });
  const append = (...records: object[]) =>
    appendFileSync(events, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const read = createAgentActionReader({
    sessionsDirs: [sessionsDir],
    targets: [{ platform: 'macos', id: 'launch', slot: 'default', bundleId: 'dev.owned', launchedAt }],
  });
  inode.value = 9851624185071827n;
  append(open(0), event(1, 'press'));
  expect(read().map((record) => record.command)).toEqual(['open', 'press']);
  append(open(2, 'dev.other'));
  renameSync(events, `${events}.1`);
  inode.value = 9851624185071829n;
  append(...Array.from({ length: 20 }, (_, index) => event(index + 3, 'press')));
  expect(read()).toEqual([]);
  append(open(25), event(26, 'type'));
  expect(read().map((record) => record.command)).toEqual(['open', 'type']);
});

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
