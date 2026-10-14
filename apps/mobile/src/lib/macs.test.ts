import type * as Macs from '@/lib/macs';

const mockSecure = new Map<string, string>();
let mockClientKey = 'key-a';
let mockFailWrites = false;
let mockWrites = 0;
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => mockSecure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    if (mockFailWrites) throw new Error('Keychain write failed');
    await new Promise((resolve) => setTimeout(resolve, mockWrites++ === 0 ? 30 : 1));
    mockSecure.set(key, value);
  },
  deleteItemAsync: async (key: string) => void mockSecure.delete(key),
}));
jest.mock('react-native-stim-session', () => ({ clientPublicKey: () => mockClientKey }));

const current = { id: 'new', name: 'Mac', endpoint: 'ws://10.0.0.2', pairedAt: '2026-10-13', serverKey: 'k' };
const legacy = { id: 'old', name: 'Old', endpoint: 'wss://old.ts.net', pairedAt: '2026-09-01' };

/** A fresh copy of the module, since it checks the client key once per launch. */
function load(): typeof Macs {
  let macs!: typeof Macs;
  jest.isolateModules(() => {
    macs = jest.requireActual('@/lib/macs');
  });
  return macs;
}

beforeEach(() => {
  mockSecure.clear();
  mockClientKey = 'key-a';
  mockFailWrites = false;
  mockWrites = 0;
});

test('drops a protocol 1 pairing and its device token, keeping protocol 2 pairings', async () => {
  mockSecure.set('stim.macs', JSON.stringify([legacy, current]));
  mockSecure.set('stim.mac.old.token', 'device-token');
  mockSecure.set('stim.mac.new.token', 'unrelated');

  expect(await load().listMacs()).toEqual([current]);
  expect(mockSecure.has('stim.mac.old.token')).toBe(false);
  expect(JSON.parse(mockSecure.get('stim.macs')!)).toEqual([current]);
});

test('drops every saved Mac when the session made a new client key, and keeps them when the key is the same', async () => {
  mockSecure.set('stim.macs', JSON.stringify([current]));
  expect(await load().listMacs()).toEqual([current]);
  expect(mockSecure.get('stim.client-key')).toBe('key-a');
  expect(await load().listMacs()).toEqual([current]);
  mockClientKey = 'key-b';
  expect(await load().listMacs()).toEqual([]);
  expect(mockSecure.get('stim.macs')).toBe('[]');
});

test('a migration running beside a save does not write back the index the save replaced', async () => {
  mockSecure.set('stim.macs', JSON.stringify([legacy, current]));
  const macs = load();
  const [, saved] = await Promise.all([
    macs.listMacs(),
    macs.saveMac({ name: 'Studio', endpoint: 'ws://10.0.0.3', serverKey: 'k2' }),
  ]);
  expect((await macs.listMacs()).map((mac) => mac.id)).toEqual([current.id, saved.id]);
});

test('reports a migration that cannot write instead of returning no Macs', async () => {
  mockSecure.set('stim.macs', JSON.stringify([legacy, current]));
  mockSecure.set('stim.client-key', 'key-a');
  mockFailWrites = true;
  await expect(load().listMacs()).rejects.toThrow('Keychain write failed');
});
