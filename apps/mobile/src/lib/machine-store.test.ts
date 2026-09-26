import fixture from '../../mock-server/fixtures/status.json';

import { createMachineStore } from '@/lib/machine-store';
import type { PairedMac } from '@/lib/macs';
import { StatusCache, type KeyValueStore } from '@/lib/status-cache';
import type { StatusPayload } from '@/protocol/types';

const status = fixture.payload as StatusPayload;
const clone = (): StatusPayload => JSON.parse(JSON.stringify(status)) as StatusPayload;
const mac = (id: string, name = `Mac ${id}`): PairedMac => ({ id, name, endpoint: `ws://${id}`, pairedAt: '' });
const OPEN = { kind: 'open', server: {}, actions: [], capabilities: [] } as never;

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

const cached = (store: KeyValueStore) => new StatusCache(store).readAll();

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('createMachineStore', () => {
  it('starts with the cached statuses, marked cached, and their workspaces before the pairings load', () => {
    const store = memoryStore();
    new StatusCache(store).write('a', { status, name: 'Mac A', seenAt: 1234 });
    const machines = createMachineStore({ cache: new StatusCache(store) });
    const state = machines.store.getState();
    expect(state.macs).toBeNull();
    expect(state.snapshots.a).toEqual({ status, name: 'Mac A', cachedSeenAt: 1234 });
    expect(state.workspaces).toHaveLength(status.environments.length);
    expect(state.workspaces[0].macName).toBe('Mac A');
  });

  it('changes nothing for a push equal to the live status', () => {
    const machines = createMachineStore();
    machines.receiveStatus('a', clone());
    const before = machines.store.getState();
    const listener = jest.fn();
    machines.store.subscribe(listener);
    machines.receiveStatus('a', clone());
    expect(listener).not.toHaveBeenCalled();
    expect(machines.store.getState()).toBe(before);
  });

  it('keeps unchanged workspace items when one workspace changes', () => {
    const machines = createMachineStore();
    machines.setMacs([mac('a')], true);
    machines.receiveStatus('a', clone());
    const before = machines.store.getState().workspaces;
    const next = clone();
    next.environments[0].memoryMb += 1;
    machines.receiveStatus('a', next);
    const after = machines.store.getState().workspaces;
    const changed = after.filter((item) => !before.includes(item));
    expect(changed.map((item) => item.env.path)).toEqual([next.environments[0].path]);
  });

  it('replaces a cached status with the live one, even when equal', () => {
    const store = memoryStore();
    new StatusCache(store).write('a', { status, name: 'Mac A', seenAt: 1 });
    const machines = createMachineStore({ cache: new StatusCache(store) });
    const { status: hydrated } = machines.store.getState().snapshots.a;
    const { workspaces } = machines.store.getState();
    machines.receiveStatus('a', clone());
    const snapshot = machines.store.getState().snapshots.a;
    expect(snapshot.cachedSeenAt).toBeNull();
    expect(snapshot.status).toBe(hydrated);
    expect(machines.store.getState().workspaces).toBe(workspaces);
  });

  it('writes the latest live status once per delay, stamped with the time while connected', () => {
    const store = memoryStore();
    const machines = createMachineStore({ cache: new StatusCache(store), writeDelayMs: 5000, now: () => 7000 });
    machines.setMacs([mac('a')], true);
    machines.patchLink('a', { state: OPEN });
    machines.receiveStatus('a', clone());
    const next = clone();
    next.environments[0].memoryMb += 1;
    machines.receiveStatus('a', next);
    expect(cached(store)).toEqual({});
    jest.advanceTimersByTime(5000);
    expect(cached(store)).toEqual({ a: { status: next, name: 'Mac a', seenAt: 7000 } });
  });

  it('writes at once when the connection drops, stamped with the drop', () => {
    const store = memoryStore();
    const machines = createMachineStore({ cache: new StatusCache(store), now: () => 9000 });
    machines.setMacs([mac('a')], true);
    machines.patchLink('a', { state: OPEN });
    machines.receiveStatus('a', clone());
    machines.patchLink('a', { state: { kind: 'waiting', reason: 'Gone.', retryInMs: 1000 }, disconnectedAt: 8000 });
    expect(cached(store).a.seenAt).toBe(8000);
  });

  it('does not write back a status that is still the cached one', () => {
    const store = memoryStore();
    new StatusCache(store).write('a', { status, name: 'Mac A', seenAt: 1 });
    const machines = createMachineStore({ cache: new StatusCache(store), now: () => 5 });
    machines.flushAll();
    expect(cached(store).a.seenAt).toBe(1);
  });

  it('forgets the status and cache entry of an unpaired machine, but not on a failed pairing read', () => {
    const store = memoryStore();
    const cache = new StatusCache(store);
    cache.write('a', { status, name: 'A', seenAt: 1 });
    cache.write('b', { status, name: 'B', seenAt: 1 });
    const machines = createMachineStore({ cache: new StatusCache(store) });
    machines.setMacs([], false);
    expect(Object.keys(machines.store.getState().snapshots).sort()).toEqual(['a', 'b']);
    machines.setMacs([mac('b')], true);
    expect(Object.keys(machines.store.getState().snapshots)).toEqual(['b']);
    expect(Object.keys(cached(store))).toEqual(['b']);
    expect(machines.store.getState().workspaces.every((item) => item.macId === 'b')).toBe(true);
  });
});
