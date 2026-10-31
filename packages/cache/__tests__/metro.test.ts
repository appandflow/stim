import { createTieredMetroStore, type MetroCacheStore, type TieredMetroStoreOptions } from '../metro.ts';
import type { LoadCacheProviderResult, MetroCacheCapability } from '../provider.ts';

function memoryStore(): MetroCacheStore & { entries: Map<string, unknown>; cleared: number } {
  const entries = new Map<string, unknown>();
  return {
    entries,
    cleared: 0,
    async get(key: Buffer) {
      return entries.has(key.toString('hex')) ? entries.get(key.toString('hex')) : null;
    },
    async set(key: Buffer, value: unknown) {
      entries.set(key.toString('hex'), value);
    },
    clear() {
      this.cleared += 1;
    },
  };
}

function tracked(capability: Partial<MetroCacheCapability> = {}) {
  const calls = { get: 0, set: 0 };
  const entries = new Map<string, unknown>();
  const provider: MetroCacheCapability = {
    get: async (input) => {
      calls.get += 1;
      if (capability.get) return capability.get(input);
      return entries.get(input.key.toString('hex')) ?? null;
    },
    set: async (input) => {
      calls.set += 1;
      if (capability.set) return capability.set(input);
      entries.set(input.key.toString('hex'), input.value);
    },
  };
  return { provider, calls, entries };
}

function store(
  options: Partial<TieredMetroStoreOptions> & {
    local: MetroCacheStore;
    loadProvider: () => Promise<LoadCacheProviderResult>;
  },
) {
  const warnings: Array<{ code: string; message: string }> = [];
  const tiered = createTieredMetroStore({
    projectRoot: '/repo/app',
    cacheName: 'app',
    warn: (code, message) => warnings.push({ code, message }),
    ...options,
  });
  return { tiered, warnings };
}

const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');

test('one warning is emitted per failure class', async () => {
  const local = memoryStore();
  const provider = tracked({
    get: () => {
      throw new Error('read denied');
    },
    set: () => {
      throw new Error('write denied');
    },
  });
  const { tiered, warnings } = store({ local, loadProvider: async () => ({ provider: { metro: provider.provider } }) });

  await tiered.get(KEY);
  await tiered.get(KEY);
  await tiered.set(KEY, Buffer.from('a'));
  await tiered.set(KEY, Buffer.from('b'));
  await tiered.flush();

  expect(warnings.map((w) => w.code)).toEqual(['provider-read', 'provider-write']);
  expect(warnings[0]?.message).toMatch(/read denied/);
  expect(warnings[1]?.message).toMatch(/write denied/);
});

test('the queue enforces item and byte limits', async () => {
  const local = memoryStore();
  let release = (): void => {};
  const blocked = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  const provider = tracked({ set: async () => blocked });
  const { tiered, warnings } = store({
    local,
    loadProvider: async () => ({ provider: { metro: provider.provider } }),
    limits: { concurrency: 1, maxItems: 2, maxBytes: 1024 },
  });

  await tiered.set(Buffer.from('01', 'hex'), Buffer.alloc(8));
  await tiered.set(Buffer.from('02', 'hex'), Buffer.alloc(8));
  await tiered.set(Buffer.from('03', 'hex'), Buffer.alloc(8));
  expect(warnings.map((w) => w.code)).toEqual(['provider-queue']);
  expect(provider.calls.set).toBe(1);

  release();
  await tiered.flush();
  expect(provider.calls.set).toBe(2);

  await tiered.set(Buffer.from('04', 'hex'), Buffer.alloc(2048));
  expect(provider.calls.set).toBe(2);
  expect(local.entries.size).toBe(4);
});

test('a value that cannot be measured stays local', async () => {
  const local = memoryStore();
  const provider = tracked();
  const { tiered, warnings } = store({ local, loadProvider: async () => ({ provider: { metro: provider.provider } }) });

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await tiered.set(KEY, cyclic);
  await tiered.flush();

  expect(local.entries.get(KEY.toString('hex'))).toBe(cyclic);
  expect(provider.calls.set).toBe(0);
  expect(warnings.map((w) => w.code)).toEqual(['provider-write']);
});

test('provider reads are capped so a slow provider cannot fan out per transform', async () => {
  const local = memoryStore();
  let release = (): void => {};
  const blocked = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  const provider = tracked({ get: async () => blocked.then(() => null) });
  const { tiered, warnings } = store({
    local,
    loadProvider: async () => ({ provider: { metro: provider.provider } }),
    limits: { readConcurrency: 2 },
    timeouts: { readMs: 5_000 },
  });

  const reads = [
    tiered.get(Buffer.from('01', 'hex')),
    tiered.get(Buffer.from('02', 'hex')),
    tiered.get(Buffer.from('03', 'hex')),
    tiered.get(Buffer.from('04', 'hex')),
  ];
  expect(await Promise.all(reads.slice(2))).toEqual([null, null]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(provider.calls.get).toBe(2);
  expect(warnings.map((w) => w.code)).toEqual(['provider-read-busy']);

  release();
  expect(await Promise.all(reads.slice(0, 2))).toEqual([null, null]);
});

test('an unusable provider disables the tier for writes too', async () => {
  const local = memoryStore();
  let loads = 0;
  const { tiered, warnings } = store({
    local,
    loadProvider: async () => {
      loads += 1;
      return { name: './cache.cjs', unavailable: 'missing credentials' };
    },
  });

  expect(await tiered.get(KEY)).toBeNull();
  await tiered.set(KEY, Buffer.from('fresh'));
  await tiered.flush();
  expect(loads).toBe(1);
  expect(warnings.map((w) => w.code)).toEqual(['provider-load']);
});

test('a tripped breaker drops the queued backlog instead of draining it', async () => {
  const local = memoryStore();
  let release = (): void => {};
  const blocked = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  let writes = 0;
  const provider = tracked({
    get: () => {
      throw new Error('unauthorized');
    },
    set: async () => {
      writes += 1;
      return blocked;
    },
  });
  const { tiered, warnings } = store({
    local,
    loadProvider: async () => ({ provider: { metro: provider.provider } }),
    limits: { concurrency: 1, failureLimit: 2 },
  });

  await tiered.set(Buffer.from('01', 'hex'), Buffer.from('one'));
  await tiered.set(Buffer.from('02', 'hex'), Buffer.from('two'));
  await tiered.set(Buffer.from('03', 'hex'), Buffer.from('three'));
  expect(writes).toBe(1);

  expect(await tiered.get(Buffer.from('04', 'hex'))).toBeNull();
  expect(await tiered.get(Buffer.from('05', 'hex'))).toBeNull();
  expect(warnings.map((w) => w.code)).toEqual(['provider-read', 'provider-disabled']);

  release();
  await tiered.flush();
  expect(writes).toBe(1);
  expect(local.entries.size).toBe(3);
});
