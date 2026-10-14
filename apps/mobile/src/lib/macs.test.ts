import { listMacs } from '@/lib/macs';

const mockSecure = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => mockSecure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void mockSecure.set(key, value),
  deleteItemAsync: async (key: string) => void mockSecure.delete(key),
}));

test('drops a protocol 1 pairing and its device token, keeping protocol 2 pairings', async () => {
  const current = { id: 'new', name: 'Mac', endpoint: 'ws://10.0.0.2', pairedAt: '2026-10-13', serverKey: 'k' };
  mockSecure.set(
    'stim.macs',
    JSON.stringify([{ id: 'old', name: 'Old', endpoint: 'wss://old.ts.net', pairedAt: '2026-09-01' }, current]),
  );
  mockSecure.set('stim.mac.old.token', 'device-token');
  mockSecure.set('stim.mac.new.token', 'unrelated');

  expect(await listMacs()).toEqual([current]);
  expect(mockSecure.has('stim.mac.old.token')).toBe(false);
  expect(JSON.parse(mockSecure.get('stim.macs')!)).toEqual([current]);
});
