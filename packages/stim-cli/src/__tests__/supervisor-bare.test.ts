import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCacheStore, hasStoreAt, metroStoreRoot } from '../supervisor/metro-store.ts';
import {
  loadNdjsonReporter,
  normalizeMetroTransformerPaths,
  resolveBareDeps,
  startBareServer,
  symbolicationReporterMiddleware,
} from '../supervisor/server-bare.ts';
import type { NdjsonRecord, NdjsonWriter } from '../ndjson.ts';
import { asRequire, makeError, makeWriter } from './_factories.ts';

function caught(fn: () => unknown): Error & Record<string, unknown> {
  try {
    fn();
  } catch (err) {
    return err as Error & Record<string, unknown>;
  }
  throw new Error('expected a throw');
}

let root: string;
let tmpHome: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-bare-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bare' }));
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  delete process.env.STIM_METRO_CACHE;
});

function fakeRequire(
  modules: Record<string, unknown>,
  { throwOnLoad = {} }: { throwOnLoad?: Record<string, string> } = {},
) {
  const localRequire = (id: string) => {
    if (throwOnLoad[id]) throw new Error(throwOnLoad[id]);
    if (!(id in modules)) {
      throw makeError(`Cannot find module '${id}'`, { code: 'MODULE_NOT_FOUND' });
    }
    return modules[id];
  };
  localRequire.resolve = (id: string) => {
    if (!(id in modules) && !(id in throwOnLoad)) {
      throw makeError(`Cannot find module '${id}'`, { code: 'MODULE_NOT_FOUND' });
    }
    return id;
  };
  return () => asRequire(localRequire);
}

type OkModules = {
  metro: { loadConfig: () => Promise<unknown>; runServer?: () => Promise<unknown> };
  '@react-native/dev-middleware'?: { createDevMiddleware: () => unknown };
  '@react-native-community/cli-server-api'?: { createDevServerMiddleware: () => unknown };
};

const OK_MODULES = (): OkModules => ({
  metro: { loadConfig: async () => ({}), runServer: async () => ({}) },
  '@react-native/dev-middleware': { createDevMiddleware: () => ({ middleware: 'dm', websocketEndpoints: {} }) },
  '@react-native-community/cli-server-api': {
    createDevServerMiddleware: () => ({ middleware: 'cm', websocketEndpoints: {} }),
  },
});

describe("resolving the project's own dev server packages", () => {
  test('every missing package is named at once, with an npm install remedy', () => {
    const modules = OK_MODULES();
    delete modules['@react-native/dev-middleware'];
    delete modules['@react-native-community/cli-server-api'];
    const err = caught(() => resolveBareDeps(root, { requireFrom: fakeRequire(modules) }));
    expect(err.code).toBe('STIM_BARE_DEPS');
    expect(err.message).toMatch(/@react-native\/dev-middleware/);
    expect(err.message).toMatch(/@react-native-community\/cli-server-api/);
    expect(!err.message.includes(' metro,')).toBeTruthy();
    expect(err.message).toMatch(new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(err.remedy).toMatch(/npm install/);
    expect(err.remedy).toMatch(/Expo/);
  });

  test('a package whose API does not match names the package and the export', () => {
    const modules = OK_MODULES();
    delete modules['metro'].runServer;
    const err = caught(() => resolveBareDeps(root, { requireFrom: fakeRequire(modules) }));
    expect(err.code).toBe('STIM_BARE_API');
    expect(err.message).toMatch(/metro does not export runServer\(\)/);
    expect(!/undefined is not a function/.test(err.message)).toBeTruthy();
  });
});

describe('config adjustments', () => {
  test('rewrites the metro-runtime asyncRequire path to the specifier Metro resolves from any module (#476)', () => {
    const config = {
      transformer: {
        asyncRequireModulePath: join(root, 'node_modules', 'metro-runtime', 'src', 'modules', 'asyncRequire.js'),
      },
    };
    expect(normalizeMetroTransformerPaths(config, root)).toBe(true);
    expect(config.transformer.asyncRequireModulePath).toBe('metro-runtime/src/modules/asyncRequire');
  });
});

describe('the symbolication reporter middleware', () => {
  test('ignores unrelated and malformed responses', () => {
    const events: unknown[] = [];
    const reporter = { update: (event: unknown) => events.push(event) };
    const unrelated = { end() {} };
    symbolicationReporterMiddleware(reporter)({ url: '/status' }, unrelated, () => {});
    const malformed = { end(..._args: unknown[]) {} };
    symbolicationReporterMiddleware(reporter)({ url: '/symbolicate?x=1' }, malformed, () => {});
    malformed.end('not json');
    expect(events).toEqual([]);
  });
});

describe('loadNdjsonReporter', () => {
  test('resolves the one shared implementation from @stim-cli/metro', () => {
    const factory = loadNdjsonReporter(root);
    expect(typeof factory).toBe('function');
    assert(factory);
    const reporter = factory({ dir: join(root, '.stim', 'logs') });
    expect(typeof reporter.update).toBe('function');
  });
});

describe('startBareServer wiring', () => {
  function fakeDeps() {
    interface FakeCalls {
      loadConfig?: { cwd: string; port: number };
      runServer: {
        config: { reporter?: unknown; resolver: { platforms: unknown } };
        options: { unstable_extraMiddleware?: unknown; websocketEndpoints?: unknown; host?: unknown };
      };
      createDevMiddleware: { serverBaseUrl?: unknown; logger: { error?: unknown } };
      createDevServerMiddleware?: unknown;
      reporterDir?: unknown;
      closed?: boolean;
      closedConnections?: boolean;
    }
    const calls = {} as FakeCalls;
    const httpServer = {
      handlers: {} as Record<string, (...args: unknown[]) => void>,
      on(event: string, cb: (...args: unknown[]) => void) {
        this.handlers[event] = cb;
      },
      closeAllConnections() {
        calls.closedConnections = true;
      },
      close(cb?: () => void) {
        calls.closed = true;
        cb?.();
      },
    };
    const deps = {
      metro: {
        async loadConfig(argv: { cwd: string; port: number }) {
          calls.loadConfig = argv;
          return { resolver: { platforms: ['android', 'ios'] }, watchFolders: ['/w'], server: {} };
        },
        async runServer(config: FakeCalls['runServer']['config'], options: FakeCalls['runServer']['options']) {
          calls.runServer = { config, options };
          return httpServer;
        },
      },
      devMiddleware: {
        createDevMiddleware(args: FakeCalls['createDevMiddleware']) {
          calls.createDevMiddleware = args;
          return { middleware: 'dev-mw', websocketEndpoints: { '/inspector': 'i' } };
        },
      },
      serverApi: {
        createDevServerMiddleware(args: unknown) {
          calls.createDevServerMiddleware = args;
          return { middleware: 'community-mw', websocketEndpoints: { '/message': 'm' } };
        },
      },
    };
    return { deps, calls, httpServer };
  }

  test('passes a one-shot reset through to Metro config loading', async () => {
    const { deps, calls } = fakeDeps();
    await startBareServer({
      root,
      port: 8099,
      logsDir: join(tmpHome, 'logs'),
      deps,
      cacheStore: false,
      reporterFactory: null,
      resetCache: true,
    });
    expect(calls.loadConfig).toEqual({ cwd: root, port: 8099, resetCache: true });
  });

  test('our own close does not report an unexpected exit', async () => {
    const { deps, httpServer } = fakeDeps();
    const handle = await startBareServer({
      root,
      port: 8104,
      logsDir: join(root, 'logs'),
      deps,
      reporterFactory: () => ({ update() {} }),
    });
    const seen: Array<{ code: number; reason?: string }> = [];
    handle.onExit((info) => seen.push(info));
    await handle.close();
    httpServer.handlers.close?.();
    expect(seen).toEqual([]);
  });
});

describe('the shared Metro cache store', () => {
  class FakeStore {
    _root: string;
    constructor(options: { root: string }) {
      this._root = options.root;
    }
  }

  test('a store already pointing at our root is not added a second time', () => {
    const config: { cacheStores?: unknown } = { cacheStores: [new FakeStore({ root: '/cache/app' })] };
    const result = appendCacheStore(config, { storeRoot: '/cache/app', FileStore: FakeStore });
    expect(result.added).toBe(false);
    expect(result.reason).toMatch(/already/);
    expect((config.cacheStores as unknown[]).length).toBe(1);
    expect(hasStoreAt(config.cacheStores, '/cache/app')).toBe(true);
    expect(hasStoreAt(config.cacheStores, '/cache/other')).toBe(false);
    expect(hasStoreAt(undefined, '/cache/app')).toBe(false);
  });

  test('a function-shaped cacheStores is wrapped, not evaluated', () => {
    let calledWith: unknown = null;
    const config: { cacheStores?: unknown } = {
      cacheStores: (cache: unknown) => {
        calledWith = cache;
        return [{ name: 'lazy' }];
      },
    };
    expect(appendCacheStore(config, { storeRoot: '/cache/app', FileStore: FakeStore }).added).toBe(true);
    expect(calledWith).toBe(null);
    const resolved = (config.cacheStores as (c: unknown) => unknown[])({ marker: 1 });
    expect(calledWith).toEqual({ marker: 1 });
    expect(resolved.length).toBe(2);
    expect((resolved[1] as FakeStore)._root).toBe('/cache/app');
  });
});

describe('startBareServer and the shared store', () => {
  function recordingWriter(): NdjsonWriter & { records: NdjsonRecord[] } {
    const records: NdjsonRecord[] = [];
    const writer = makeWriter({
      write(record) {
        records.push(record as NdjsonRecord);
        return true;
      },
    });
    return Object.assign(writer, { records });
  }

  class FakeStore {
    _root: string;
    constructor(options: { root: string }) {
      this._root = options.root;
    }
  }

  function configuringDeps(initialStores: unknown) {
    const seen: { config?: { cacheStores?: unknown } } = {};
    return {
      seen,
      deps: {
        metro: {
          async loadConfig() {
            return { resolver: { platforms: ['ios'] }, watchFolders: [], cacheStores: initialStores };
          },
          async runServer(config: { cacheStores?: unknown }) {
            seen.config = config;
            return {
              on() {},
              close(cb?: () => void) {
                cb?.();
              },
            };
          },
        },
        devMiddleware: { createDevMiddleware: () => ({ middleware: 'm', websocketEndpoints: {} }) },
        serverApi: { createDevServerMiddleware: () => ({ middleware: 'c', websocketEndpoints: {} }) },
      },
    };
  }

  test('the hosted config reaches runServer with the project stores plus ours, and says so once', async () => {
    const projectStore = { name: 'project store' };
    const { deps, seen } = configuringDeps([projectStore]);
    const writer = recordingWriter();
    await startBareServer({
      root,
      port: 8200,
      logsDir: join(root, 'logs'),
      deps,
      writer,
      reporterFactory: () => ({ update() {} }),
      fileStore: FakeStore,
    });
    const stores = seen.config?.cacheStores as unknown[];
    expect(stores[0]).toBe(projectStore);
    expect((stores[1] as FakeStore)._root).toBe(metroStoreRoot(root));
    const added = writer.records.filter((r) => r.event === 'cache_store_added');
    expect(added.length).toBe(1);
    expect(added[0]?.msg).toContain(metroStoreRoot(root));
  });
});
