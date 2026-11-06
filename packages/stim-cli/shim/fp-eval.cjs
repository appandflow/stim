'use strict';

// Fingerprint evaluator child: `fp-eval.cjs expo|embed|rn <root> <platform> [mode] [expo-constants dir]`, run with cwd at the project's
// real path and fp-trace.cjs preloaded. Writes one JSON object on fd 3; any failure exits non-zero.

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const RESULT_FD = 3;
const [kind, root, platform, embedMode, constantsDir] = process.argv.slice(2);
const fromRoot = createRequire(path.join(root, 'package.json'));
const requireFrom = (dir, id) => require(createRequire(path.join(dir, 'package.json')).resolve(id));
const packageDir = (from, name) => path.dirname(from.resolve(`${name}/package.json`));

function write(result) {
  const bytes = Buffer.from(JSON.stringify(result));
  for (let offset = 0; offset < bytes.length;) {
    try {
      offset += fs.writeSync(RESULT_FD, bytes, offset);
    } catch (error) {
      if (error.code !== 'EAGAIN') throw error;
    }
  }
}

// @expo/cli's `getConfigEnvMode` (SDK 58, @expo/env exporting consumeConfigEnvMode) and `setNodeEnv` (SDK 55 to 57,
// which keep an inherited NODE_ENV); EAS_BUILD is parsed by getenv's `boolish`, which throws on other values.
function configMode(expoEnv) {
  if (typeof expoEnv.consumeConfigEnvMode !== 'function') {
    void process.env.BABEL_ENV;
    return process.env.NODE_ENV || 'development';
  }
  const explicit = expoEnv.consumeConfigEnvMode();
  if (explicit) return explicit;
  const eas = process.env.EAS_BUILD;
  if (eas === undefined) return 'development';
  if (!/^(true|false|1|0)$/i.test(eas)) throw new Error(`EAS_BUILD=${eas} is not a boolean`);
  return /^(true|1)$/i.test(eas) ? 'production' : 'development';
}

function loadExpo() {
  const expoDir = packageDir(fromRoot, 'expo');
  const cliDir = packageDir(createRequire(path.join(expoDir, 'package.json')), '@expo/cli');
  return {
    expoDir,
    expoEnv: requireFrom(cliDir, '@expo/env'),
    getConfig: fromRoot('expo/config').getConfig,
  };
}

function applyMode(expoEnv, mode) {
  process.env.NODE_ENV = mode;
  process.env.BABEL_ENV = process.env.BABEL_ENV || mode;
  globalThis['__DEV__'] = mode !== 'production';
  expoEnv.loadProjectEnv(root, { mode, silent: true });
}

function fingerprintConfig() {
  const file = path.join(root, 'fingerprint.config.js');
  if (!fs.existsSync(file)) return null;
  const loaded = require(file);
  const sources = (loaded && loaded.default ? loaded.default : loaded)?.extraSources;
  return sources === undefined ? {} : { extraSources: sources };
}

async function runtimeVersion(expoDir, config) {
  const updates = requireFrom(expoDir, '@expo/config-plugins').Updates;
  const resolve = updates.getRuntimeVersionAsync ?? updates.getRuntimeVersionNullableAsync;
  return (await resolve(root, config, platform)) ?? null;
}

async function expo() {
  const { expoDir, expoEnv, getConfig } = loadExpo();
  const mode = configMode(expoEnv);
  applyMode(expoEnv, mode);
  getConfig(root, { skipSDKVersionRequirement: true, skipPlugins: true });
  const { exp } = getConfig(root, { skipSDKVersionRequirement: true });
  return {
    mode,
    config: exp,
    runtimeVersion: await runtimeVersion(expoDir, exp),
    fingerprintConfig: fingerprintConfig(),
  };
}

// expo-constants' getAppConfig.js evaluates the config embedded in the binary. Versions that call loadProjectEnv
// take the mode from the build configuration; earlier ones call @expo/env's load(), which follows the build env's
// NODE_ENV. `embedMode` is `env` for the second kind.
function embed() {
  const { expoEnv, getConfig } = loadExpo();
  if (embedMode === 'env') requireFrom(constantsDir, '@expo/env').load(root);
  else applyMode(expoEnv, embedMode);
  return { config: getConfig(root, { isPublicConfig: true, skipSDKVersionRequirement: true }).exp };
}

// cli-config's lazy getters run platform code only when serialized, so the result goes through JSON.stringify.
async function rn() {
  const cliDir = packageDir(fromRoot, '@react-native-community/cli');
  const cliConfig = requireFrom(cliDir, '@react-native-community/cli-config');
  const options = { projectRoot: root, selectedPlatform: platform };
  const loaded =
    typeof cliConfig.loadConfigAsync === 'function'
      ? await cliConfig.loadConfigAsync(options)
      : (cliConfig.default ?? cliConfig.loadConfig)(options);
  const config = JSON.parse(JSON.stringify(loaded));
  const project = config.project?.[platform];
  if (!config.platforms?.[platform] || !project || Object.keys(project).length === 0)
    throw new Error(`react-native config has no ${platform} platform or project; is cwd the project root?`);
  return { config, fingerprintConfig: fingerprintConfig() };
}

const modes = { expo, embed, rn };
Promise.resolve()
  .then(() => {
    if (!modes[kind]) throw new Error(`unknown evaluator ${kind}`);
    return modes[kind]();
  })
  .then(
    (result) => {
      write(result);
      process.exit(0);
    },
    (error) => {
      process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
      process.exit(1);
    },
  );
