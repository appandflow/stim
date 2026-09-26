import fixture from '../../mock-server/fixtures/status.json';

import { MAX_ENTRY_CHARS, StatusCache, type KeyValueStore } from '@/lib/status-cache';
import type { StatusPayload } from '@/protocol/types';

const status = fixture.payload as StatusPayload;

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

describe('StatusCache', () => {
  it('reads back what it wrote, one key per machine', () => {
    const store = memoryStore();
    new StatusCache(store).write('a', { status, name: 'Mac A', seenAt: 1000 });
    expect([...store.data.keys()]).toEqual(['status:a']);
    expect(new StatusCache(store).readAll()).toEqual({ a: { status, name: 'Mac A', seenAt: 1000 } });
  });

  it('removes unreadable and other-version entries and leaves other keys alone', () => {
    const store = memoryStore();
    store.set('status:bad', '{');
    store.set('status:old', JSON.stringify({ v: 0, name: 'x', seenAt: 1, status }));
    store.set('other', 'kept');
    expect(new StatusCache(store).readAll()).toEqual({});
    expect([...store.data.keys()]).toEqual(['other']);
  });

  it('drops a machine instead of storing a status over the size bound', () => {
    const store = memoryStore();
    const cache = new StatusCache(store);
    cache.write('a', { status, name: 'Mac', seenAt: 1 });
    const huge = { ...status, environments: [{ ...status.environments[0], warnings: ['x'.repeat(MAX_ENTRY_CHARS)] }] };
    cache.write('a', { status: huge, name: 'Mac', seenAt: 2 });
    expect(store.data.has('status:a')).toBe(false);
  });

  it('keeps only the machines still paired', () => {
    const store = memoryStore();
    const cache = new StatusCache(store);
    cache.write('a', { status, name: 'A', seenAt: 1 });
    cache.write('b', { status, name: 'B', seenAt: 1 });
    store.set('other', 'kept');
    cache.keepOnly(['b']);
    expect([...store.data.keys()].sort()).toEqual(['other', 'status:b']);
  });
});
