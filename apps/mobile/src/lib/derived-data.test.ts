import fixture from '../../mock-server/fixtures/status.json';

import type { AttentionMachine } from '@/lib/attention';
import { clearDerivedDataOnChange, MARKER_KEY, runningMarker, type DerivedDataStores } from '@/lib/derived-data';
import { DEFAULT_PREFS, localNotifications, type NotifyState } from '@/lib/notifications';
import { StatusCache, type KeyValueStore } from '@/lib/status-cache';
import type { StatusPayload } from '@/protocol/types';

const status = fixture.payload as StatusPayload;
const OTA = runningMarker('0.1.0', '87cad17f', '01a0e11b-0c1f-7c37-a436-d0b4fb90ed90');
const EMBEDDED = runningMarker('0.1.0', '87cad17f', 'bc056523-c9c4-4598-a789-fb9c0f1b4d74');

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getString: (key) => data.get(key),
    set: (key, value) => void data.set(key, value),
    remove: (key) => data.delete(key),
    getAllKeys: () => [...data.keys()],
  };
}

/** What build 13's JS left on a phone with notifications on: its notify state has no `workspaces`. */
function previousVersionStores(marker: string | null) {
  const stores = { app: memoryStore(), status: memoryStore(), notifications: memoryStore() };
  if (marker) stores.app.set(MARKER_KEY, marker);
  new StatusCache(stores.status).write('mac', { status, name: 'MacBook Pro', seenAt: 1 });
  stores.notifications.set('prefs', JSON.stringify({ enabled: true, events: ['build-failed'], agentOnly: false }));
  stores.notifications.set('pushToken', 'ExponentPushToken[x]');
  stores.notifications.set('pushed:mac', 'true');
  stores.notifications.set('inbox:mac', JSON.stringify({ log: 'L', readUpTo: 4, read: [] }));
  stores.notifications.set(
    'state',
    JSON.stringify({
      'link:mac': {},
      'status:mac': {
        [`mac\n${status.environments[0].path}\nlogs`]: {
          occurrence: '1',
          since: 1,
          heldSince: 1,
          seenAt: 1,
          notifiedAt: null,
          done: true,
          count: 1,
        },
      },
    }),
  );
  return stores;
}

const liveMac: AttentionMachine = {
  id: 'mac',
  name: 'MacBook Pro',
  state: {
    kind: 'open',
    server: { name: 'm', version: '1', stim: '1' },
    actions: null,
    capabilities: [],
    features: [],
    deviceId: null,
  },
  missing: false,
  status,
  usage: null,
  home: '/Users/me',
  disconnectedAt: null,
  seenAt: null,
};

const notifyFrom = (stores: DerivedDataStores) =>
  localNotifications(
    JSON.parse(stores.notifications.getString('state') ?? '{}') as NotifyState,
    [{ mac: liveMac, live: true, pushed: false }],
    { ...DEFAULT_PREFS, enabled: true },
    Date.now(),
    600,
    0,
  );

describe('clearDerivedDataOnChange', () => {
  it("clears a previous version's status cache and notify state, keeps settings and inbox read state, and notifying no longer throws", () => {
    for (const marker of [null, OTA]) {
      const stores = previousVersionStores(marker);
      clearDerivedDataOnChange(EMBEDDED, stores);
      expect(stores.status.getAllKeys()).toEqual([]);
      expect(stores.notifications.getAllKeys().sort()).toEqual(['inbox:mac', 'prefs', 'pushToken', 'pushed:mac']);
      expect(stores.app.getString(MARKER_KEY)).toBe(EMBEDDED);
      expect(() => notifyFrom(stores)).not.toThrow();
    }
  });

  it('leaves everything when the same JS runs again', () => {
    const stores = previousVersionStores(OTA);
    const before = [...stores.notifications.data];
    clearDerivedDataOnChange(OTA, stores);
    expect([...stores.notifications.data]).toEqual(before);
    expect(new StatusCache(stores.status).readAll()).toHaveProperty('mac');
  });
});
