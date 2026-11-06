import type { ConnectionState } from '@/lib/connection';
import { machineRecord, removeNotice } from '@/lib/machine-record';

const open = (overrides: Partial<Extract<ConnectionState, { kind: 'open' }>> = {}): ConnectionState => ({
  kind: 'open',
  server: { name: 'studio', version: '1', stim: '1' },
  protocol: 2,
  actions: [],
  capabilities: ['read'],
  hostCapabilities: [],
  deviceId: '1a2b3c4d',
  deviceName: 'Janic iPhone',
  ...overrides,
});

test('shows the machine name only when this phone labels it differently', () => {
  expect(machineRecord(open(), 'studio').serverName).toBeNull();
  expect(machineRecord(open(), 'Office').serverName).toBe('studio');
});

test('shows this phone record from hello, and nothing while not connected', () => {
  expect(machineRecord(open(), 'studio')).toMatchObject({ deviceName: 'Janic iPhone', deviceId: '1a2b3c4d' });
  expect(machineRecord(open({ deviceId: null, deviceName: null }), 'studio')).toMatchObject({
    deviceName: null,
    deviceId: null,
  });
  expect(machineRecord({ kind: 'closed' }, 'studio')).toEqual({ serverName: null, deviceName: null, deviceId: null });
});

test('names the machine by its own name and gives the revoke command with this phone id', () => {
  expect(removeNotice(open())).toBe(
    'The machine still lists this phone until you revoke it: on studio, run stim pairings revoke 1a2b3c4d.',
  );
});

test('says how to find the id from a server that does not report it, or while not connected', () => {
  expect(removeNotice(open({ deviceId: null }))).toContain("find this phone's id with stim pairings");
  expect(removeNotice({ kind: 'closed' })).toContain('stim pairings revoke <id>');
});

test('says there is nothing to revoke after the machine refused this phone as unknown', () => {
  expect(removeNotice({ kind: 'refused', code: 'unauthorized', reason: 'unknown' })).toBe(
    'The machine no longer lists this phone, so there is nothing to revoke there.',
  );
});
