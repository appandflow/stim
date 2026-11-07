'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createRequire } = require('node:module');
const { ndjsonReporter, startHeartbeat } = require('./metro-reporter.cjs');
const { bundleResponseMiddleware } = require('./bundle-response.cjs');

const BARE_PACKAGES = ['metro', '@react-native/dev-middleware', '@react-native-community/cli-server-api'];
const REQUIRED_EXPORTS = {
  metro: ['loadConfig', 'runServer'],
  '@react-native/dev-middleware': ['createDevMiddleware'],
  '@react-native-community/cli-server-api': ['createDevServerMiddleware'],
};
const STORE_ROOT_TAG = 'stimStoreRoot';
// Metro's collectDependencies emits this value verbatim as a dependency of every module with an import(), so a
// project-relative path only resolves from the project root; the bare specifier resolves from any directory.
const ASYNC_REQUIRE_MODULE = 'metro-runtime/src/modules/asyncRequire';

function hostError(code, message, remedy) {
  const error = new Error(message);
  error.code = code;
  if (remedy) error.remedy = remedy;
  return error;
}

function projectRequire(root) {
  return createRequire(path.join(root, 'package.json'));
}

function normalizeModule(mod, names) {
  if (!mod || typeof mod !== 'object') return mod;
  const has = (value) => value && names.every((name) => typeof value[name] === 'function');
  if (has(mod)) return mod;
  if (has(mod.default)) return mod.default;
  return mod;
}

function checkBareApi(modules) {
  const problems = [];
  for (const name of BARE_PACKAGES) {
    const mod = modules && modules[name];
    if (!mod) {
      problems.push(`${name} loaded but exported nothing`);
      continue;
    }
    for (const fn of REQUIRED_EXPORTS[name] || []) {
      if (typeof mod[fn] !== 'function') problems.push(`${name} does not export ${fn}()`);
    }
  }
  return problems;
}

function resolveBareDeps(root, { requireFrom = projectRequire } = {}) {
  const fromProject = requireFrom(root);
  const modules = {};
  const missing = [];
  for (const name of BARE_PACKAGES) {
    let resolved;
    try {
      resolved = fromProject.resolve(name);
    } catch {
      missing.push(name);
      continue;
    }
    try {
      modules[name] = normalizeModule(fromProject(resolved), REQUIRED_EXPORTS[name] || []);
    } catch (error) {
      throw hostError(
        'STIM_BARE_LOAD',
        `${name} is installed in ${root} but failed to load: ${(error && error.message) || error}`,
        `Check that ${name} matches this project's React Native version, then reinstall node_modules.`,
      );
    }
  }
  if (missing.length > 0) {
    throw hostError(
      'STIM_BARE_DEPS',
      `Cannot host a bare React Native dev server for ${root}: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not resolvable from the project.`,
      'Run `npm install` in the project. If this is an Expo project that was detected as bare, check that `expo` is in its dependencies and that it has an Expo config.',
    );
  }
  const problems = checkBareApi(modules);
  if (problems.length > 0) {
    throw hostError(
      'STIM_BARE_API',
      `The dev server packages in ${root} are not the API Stim expects: ${problems.join('; ')}.`,
      "Upgrade or reinstall the project's React Native toolchain so metro, @react-native/dev-middleware and @react-native-community/cli-server-api match.",
    );
  }
  return {
    metro: modules.metro,
    devMiddleware: modules['@react-native/dev-middleware'],
    serverApi: modules['@react-native-community/cli-server-api'],
  };
}

function loadFileStore(root, { requireFrom = projectRequire } = {}) {
  try {
    const Store = requireFrom(root)('metro-cache').FileStore;
    return typeof Store === 'function' ? Store : null;
  } catch {
    return null;
  }
}

function storeRootOf(store) {
  if (store === null || typeof store !== 'object') return null;
  if (typeof store[STORE_ROOT_TAG] === 'string') return store[STORE_ROOT_TAG];
  return typeof store._root === 'string' ? store._root : null;
}

function tagged(store, storeRoot) {
  try {
    Object.defineProperty(store, STORE_ROOT_TAG, { value: storeRoot, enumerable: false, configurable: true });
  } catch {}
  return store;
}

function appendCacheStore(config, { storeRoot, FileStore }) {
  if (!config || typeof config !== 'object') return { added: false, reason: 'no config to add it to' };
  const stores = config.cacheStores;
  if (typeof stores === 'function') {
    config.cacheStores = (cache) => {
      const resolved = stores(cache);
      return (Array.isArray(resolved) ? resolved : []).concat([tagged(new FileStore({ root: storeRoot }), storeRoot)]);
    };
    return { added: true };
  }
  if (Array.isArray(stores) && stores.some((store) => storeRootOf(store) === storeRoot)) {
    return { added: false, reason: 'a store already points at it' };
  }
  config.cacheStores = [
    ...(Array.isArray(stores) ? stores : []),
    tagged(new FileStore({ root: storeRoot }), storeRoot),
  ];
  return { added: true };
}

function normalizeMetroTransformerPaths(config, root) {
  const current = config && config.transformer && config.transformer.asyncRequireModulePath;
  if (typeof current !== 'string' || !path.isAbsolute(current)) return false;
  const local = path.relative(root, current).split(path.sep).join('/');
  if (local !== `node_modules/${ASYNC_REQUIRE_MODULE}.js`) return false;
  config.transformer.asyncRequireModulePath = ASYNC_REQUIRE_MODULE;
  return true;
}

function ensureNativePlatform(config) {
  const platforms = config && config.resolver && config.resolver.platforms;
  if (!Array.isArray(platforms) || platforms.includes('native')) return false;
  config.resolver.platforms = [...platforms, 'native'];
  return true;
}

function reporterLogger(reporter) {
  const at =
    (level) =>
    (...data) => {
      try {
        reporter.update({ type: 'unstable_server_log', level, data });
      } catch {}
    };
  return { info: at('info'), warn: at('warn'), error: at('error') };
}

function symbolicationReporterMiddleware(reporter) {
  return (req, res, next) => {
    if (typeof (req && req.url) !== 'string' || req.url.split('?', 1)[0] !== '/symbolicate') {
      next();
      return;
    }
    const end = res.end;
    res.end = function (chunk, ...args) {
      try {
        const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : null;
        const body = text ? JSON.parse(text) : null;
        if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
          reporter.update({ type: 'client_symbolication', codeFrame: body.codeFrame, stack: body.stack });
        }
      } catch {}
      return end.call(this, chunk, ...args);
    };
    next();
  };
}

function recordWriter(logsDir) {
  const file = path.join(logsDir, 'metro.ndjson');
  const inj = process.env.STIM_INJECTED_DIGEST;
  return (record) => {
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      fs.appendFileSync(
        file,
        `${JSON.stringify({ ts: Date.now(), src: 'metro', ...record, ...(inj ? { inj } : {}) })}\n`,
      );
    } catch {}
  };
}

function runLsof(args) {
  return new Promise((resolve, reject) =>
    execFile('lsof', args, { timeout: 2000 }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
  );
}

/**
 * Runs the project's own Metro on this process, which is the project's Node: its config, the community and dev
 * middlewares, Stim's bundle-response observer and reporter, and the shared transform store at `storeRoot` when
 * given. Resolves with the http server once it listens.
 */
async function startHost({
  root,
  port,
  logsDir,
  storeRoot = null,
  resetCache = false,
  deps = null,
  reporterFactory = ndjsonReporter,
  fileStore,
}) {
  const write = recordWriter(logsDir);
  const { metro, devMiddleware, serverApi } = deps || resolveBareDeps(root);
  const config = await metro.loadConfig({ cwd: root, port, resetCache });
  const FileStore = fileStore === undefined ? loadFileStore(root) : fileStore;
  if (!storeRoot) {
    write({
      level: 'debug',
      event: 'cache_store_skipped',
      msg: 'the shared Metro transform store is off in configuration',
    });
  } else if (!FileStore) {
    write({
      level: 'warn',
      event: 'cache_store_skipped',
      msg: `metro-cache is not resolvable from ${root}, so this dev server runs on whatever transform cache the project configured`,
    });
  } else {
    const result = appendCacheStore(config, { storeRoot, FileStore });
    write(
      result.added
        ? {
            level: 'debug',
            event: 'cache_store_added',
            msg: `appended the shared Metro transform store at ${storeRoot} to this project's cacheStores`,
          }
        : {
            level: 'debug',
            event: 'cache_store_present',
            msg: `the shared Metro transform store at ${storeRoot} was already configured (${result.reason})`,
          },
    );
    if (normalizeMetroTransformerPaths(config, root))
      write({
        level: 'debug',
        event: 'config_adjusted',
        msg: 'normalized the project-local asyncRequireModulePath for cross-worktree transform keys',
      });
  }
  if (ensureNativePlatform(config))
    write({
      level: 'debug',
      event: 'config_adjusted',
      msg: "added 'native' to resolver.platforms, as the React Native CLI does",
    });
  const reporter = reporterFactory({ dir: logsDir });
  config.reporter = reporter;
  const hostname = 'localhost';
  const community = serverApi.createDevServerMiddleware({ host: hostname, port, watchFolders: config.watchFolders });
  const dev = devMiddleware.createDevMiddleware({
    serverBaseUrl: `http://${hostname}:${port}`,
    logger: reporterLogger(reporter),
  });
  return metro.runServer(config, {
    unstable_extraMiddleware: [
      bundleResponseMiddleware(write, { runLsof: process.platform === 'darwin' ? runLsof : undefined }),
      symbolicationReporterMiddleware(reporter),
      community.middleware,
      dev.middleware,
    ],
    websocketEndpoints: { ...community.websocketEndpoints, ...dev.websocketEndpoints },
  });
}

function parseArgs(argv) {
  const options = { resetCache: false, storeRoot: null, heartbeat: null };
  const names = {
    '--root': 'root',
    '--port': 'port',
    '--logs-dir': 'logsDir',
    '--store-root': 'storeRoot',
    '--heartbeat': 'heartbeat',
  };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--reset-cache') options.resetCache = true;
    else if (names[argv[index]] && argv[index + 1] !== undefined) options[names[argv[index]]] = argv[++index];
    else throw hostError('STIM_BAD_ARG', `metro-host: unknown argument ${argv[index]}`);
  }
  options.port = Number(options.port);
  if (!options.root || !options.logsDir || !Number.isInteger(options.port) || options.port <= 0)
    throw hostError('STIM_BAD_ARG', 'metro-host: --root, --port and --logs-dir are required');
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const server = await startHost(options);
  if (options.heartbeat) startHeartbeat(options.heartbeat, { port: options.port });
  const stop = () => {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  server.on('close', () => process.exit(0));
}

if (require.main === module) {
  main().catch((error) => {
    const code = error && error.code ? `${error.code}: ` : '';
    const remedy = error && error.remedy ? ` Remedy: ${error.remedy}` : '';
    process.stderr.write(`${code}${(error && error.message) || error}${remedy}\n`);
    process.exit(1);
  });
}

module.exports = {
  BARE_PACKAGES,
  appendCacheStore,
  checkBareApi,
  ensureNativePlatform,
  loadFileStore,
  normalizeMetroTransformerPaths,
  parseArgs,
  reporterLogger,
  resolveBareDeps,
  startHost,
  symbolicationReporterMiddleware,
};
