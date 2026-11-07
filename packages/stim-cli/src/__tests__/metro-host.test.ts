import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendCacheStore,
  normalizeMetroTransformerPaths,
  resolveBareDeps,
  startHost,
  symbolicationReporterMiddleware,
} from '../injected/metro-host.cjs';
import { parseNdjsonText } from '../ndjson.ts';
import { asRequire, makeError } from './_factories.ts';

function caught(fn: () => unknown): Error & { code: unknown; remedy: unknown } {
  try {
    fn();
  } catch (err) {
    if (err instanceof Error)
      return Object.assign(err, { code: Reflect.get(err, 'code'), remedy: Reflect.get(err, 'remedy') });
  }
  throw new Error('expected a throw');
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-bare-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bare' }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fakeRequire(modules: Record<string, unknown>) {
  const localRequire = (id: string) => {
    if (!(id in modules)) throw makeError(`Cannot find module '${id}'`, { code: 'MODULE_NOT_FOUND' });
    return modules[id];
  };
  localRequire.resolve = (id: string) => {
    if (!(id in modules)) throw makeError(`Cannot find module '${id}'`, { code: 'MODULE_NOT_FOUND' });
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
    expect(err.message).toContain(root);
    expect(err.remedy).toMatch(/npm install/);
    expect(err.remedy).toMatch(/Expo/);
  });

  test('a package whose API does not match names the package and the export', () => {
    const modules = OK_MODULES();
    delete modules.metro.runServer;
    const err = caught(() => resolveBareDeps(root, { requireFrom: fakeRequire(modules) }));
    expect(err.code).toBe('STIM_BARE_API');
    expect(err.message).toMatch(/metro does not export runServer\(\)/);
  });
});

test('rewrites the metro-runtime asyncRequire path to the specifier Metro resolves from any module (#476)', () => {
  const config = {
    transformer: {
      asyncRequireModulePath: join(root, 'node_modules', 'metro-runtime', 'src', 'modules', 'asyncRequire.js'),
    },
  };
  expect(normalizeMetroTransformerPaths(config, root)).toBe(true);
  expect(config.transformer.asyncRequireModulePath).toBe('metro-runtime/src/modules/asyncRequire');
});

test('the symbolication reporter middleware ignores unrelated and malformed responses', () => {
  const events: unknown[] = [];
  const reporter = { update: (event: unknown) => events.push(event) };
  symbolicationReporterMiddleware(reporter)({ url: '/status' }, { end() {} }, () => {});
  const malformed = { end(..._args: unknown[]) {} };
  symbolicationReporterMiddleware(reporter)({ url: '/symbolicate?x=1' }, malformed, () => {});
  malformed.end('not json');
  expect(events).toEqual([]);
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
    expect(result).toMatchObject({ added: false, reason: expect.stringMatching(/already/) });
    expect(config.cacheStores).toHaveLength(1);
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
    const stores = config.cacheStores;
    expect(typeof stores === 'function' && stores({ marker: 1 })).toEqual([{ name: 'lazy' }, { _root: '/cache/app' }]);
    expect(calledWith).toEqual({ marker: 1 });
  });
});

describe('startHost', () => {
  function deps(initialStores: unknown) {
    const seen: { loadConfig?: unknown; config?: { cacheStores?: unknown; resolver?: unknown } } = {};
    const httpServer = { listening: true };
    return {
      seen,
      httpServer,
      deps: {
        metro: {
          async loadConfig(argv: unknown) {
            seen.loadConfig = argv;
            return { resolver: { platforms: ['ios'] }, watchFolders: [], cacheStores: initialStores };
          },
          async runServer(config: { cacheStores?: unknown }) {
            seen.config = config;
            return { httpServer };
          },
        },
        devMiddleware: { createDevMiddleware: () => ({ middleware: 'm', websocketEndpoints: {} }) },
        serverApi: { createDevServerMiddleware: () => ({ middleware: 'c', websocketEndpoints: {} }) },
      },
    };
  }

  test("resolves with Metro's http server, passing a one-shot reset and the native platform through", async () => {
    const { deps: fake, seen, httpServer } = deps(undefined);
    const server = await startHost({
      root,
      port: 8099,
      logsDir: join(root, 'logs'),
      deps: fake,
      reporterFactory: () => ({ update() {} }),
      fileStore: null,
      resetCache: true,
    });
    expect(server).toBe(httpServer);
    expect(seen.loadConfig).toEqual({ cwd: root, port: 8099, resetCache: true });
    expect(seen.config?.resolver).toEqual({ platforms: ['ios', 'native'] });
  });

  test('the hosted config reaches runServer with the project stores plus ours, and says so once', async () => {
    class FakeStore {
      _root: string;
      constructor(options: { root: string }) {
        this._root = options.root;
      }
    }
    const projectStore = { name: 'project store' };
    const { deps: fake, seen } = deps([projectStore]);
    await startHost({
      root,
      port: 8200,
      logsDir: join(root, 'logs'),
      storeRoot: '/cache/app',
      deps: fake,
      reporterFactory: () => ({ update() {} }),
      fileStore: FakeStore,
    });
    expect(seen.config?.cacheStores).toEqual([projectStore, { _root: '/cache/app' }]);
    const added = parseNdjsonText(readFileSync(join(root, 'logs', 'metro.ndjson'), 'utf8')).filter(
      (record) => record.event === 'cache_store_added',
    );
    expect(added).toMatchObject([{ msg: expect.stringContaining('/cache/app') }]);
  });
});
