import type { ConnectionState } from '@/lib/connection';
import { machineRecord } from '@/lib/machine-record';

const open = (overrides: Partial<Extract<ConnectionState, { kind: 'open' }>> = {}): ConnectionState => ({
  kind: 'open',
  server: { name: 'studio', version: '1', stim: '1' },
  protocol: 2,
  actions: [],
  capabilities: ['read'],
  features: [],
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
