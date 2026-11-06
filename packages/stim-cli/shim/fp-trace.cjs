'use strict';

// Preloaded with --require into every fingerprint evaluator child. Records what the evaluation read and writes it
// as one JSON object on fd 4 at exit: env names, files, directory listings, existence probes, compiled modules, the
// files of code that enumerated process.env, and the calls that make a result unrepeatable.

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');

const TRACE_FD = 4;
const env = new Set();
const enumerationSites = new Set();
const enumerators = new Set();
const reads = new Map();
const modules = new Map();
const opaque = new Set();
let active = true;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const originalReaddirSync = fs.readdirSync;

function toPath(target) {
  if (typeof target === 'string') return path.resolve(target);
  if (Buffer.isBuffer(target)) return path.resolve(target.toString());
  if (target instanceof URL && target.protocol === 'file:') return fileURLToPath(target);
  return null;
}

function record(kind, target) {
  const file = active && kind ? toPath(target) : null;
  if (!file || reads.has(`${kind}\0${file}`)) return;
  const entry = { path: file, kind };
  if (kind === 'dir') {
    try {
      entry.hash = sha256(JSON.stringify(originalReaddirSync(file).map(String).toSorted()));
    } catch {}
  }
  reads.set(`${kind}\0${file}`, entry);
}

const missing = (error) => error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
const kindOf = (kind, rest) => (typeof kind === 'function' ? kind(rest) : kind);
const opened = ([flags]) =>
  flags === undefined || typeof flags === 'function' || flags === 0 || flags === 'r' || flags === 'rs' ? 'file' : null;

function sync(name, kind, absentWhen) {
  const original = fs[name];
  const wrapped = function (target, ...rest) {
    let result;
    try {
      result = original.call(this, target, ...rest);
    } catch (error) {
      if (missing(error)) record('absent', target);
      throw error;
    }
    record(absentWhen?.(result) ? 'absent' : kindOf(kind, rest), target);
    return result;
  };
  if (original.native) wrapped.native = original.native;
  fs[name] = wrapped;
}

function callback(name, kind) {
  const original = fs[name];
  const wrapped = function (target, ...rest) {
    const done = rest.at(-1);
    if (typeof done === 'function')
      rest[rest.length - 1] = (error, ...results) => {
        if (!error) record(kindOf(kind, rest), target);
        else if (missing(error)) record('absent', target);
        done(error, ...results);
      };
    return original.call(this, target, ...rest);
  };
  if (original.native) wrapped.native = original.native;
  fs[name] = wrapped;
}

function promise(name, kind) {
  const original = fs.promises[name];
  fs.promises[name] = function (target, ...rest) {
    return original.call(this, target, ...rest).then(
      (result) => (record(kindOf(kind, rest), target), result),
      (error) => {
        if (missing(error)) record('absent', target);
        throw error;
      },
    );
  };
}

for (const name of ['readFileSync', 'createReadStream']) sync(name, 'file');
sync('openSync', opened);
for (const name of ['readdirSync', 'opendirSync']) sync(name, 'dir');
for (const name of ['statSync', 'lstatSync']) sync(name, 'present', (result) => result === undefined);
for (const name of ['accessSync', 'realpathSync']) sync(name, 'present');
sync('existsSync', 'present', (result) => !result);
callback('readFile', 'file');
callback('open', opened);
for (const name of ['readdir', 'opendir']) callback(name, 'dir');
for (const name of ['stat', 'lstat', 'access', 'realpath']) callback(name, 'present');
promise('readFile', 'file');
promise('open', opened);
for (const name of ['readdir', 'opendir']) promise(name, 'dir');
for (const name of ['stat', 'lstat', 'access', 'realpath']) promise(name, 'present');

/**
 * The first caller frame outside this file and Node's own code, as `file:line:column`, and whether a frame of Node's
 * own code (a child process copying the env) came first.
 */
function callerSite() {
  const prepare = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  Error.prepareStackTrace = (_, frames) => frames;
  Error.stackTraceLimit = 16;
  const holder = {};
  Error.captureStackTrace(holder, callerSite);
  const frames = holder.stack;
  Error.prepareStackTrace = prepare;
  Error.stackTraceLimit = limit;
  let internal = false;
  for (const frame of Array.isArray(frames) ? frames : []) {
    const file = frame.getFileName();
    if (!file || file === __filename) continue;
    if (file.startsWith('node:')) {
      internal = true;
      continue;
    }
    return {
      internal,
      file: file.startsWith('file:') ? fileURLToPath(file) : file,
      site: `${file}:${frame.getLineNumber()}:${frame.getColumnNumber()}`,
    };
  }
  return null;
}

// A spread, Object.assign or Object.entries of process.env reads every name from the site that enumerated it; those
// reads are the enumeration, recorded once with the enumerating file, not as reads of each name.
const realEnv = process.env;
const read = (key) => {
  if (active && typeof key === 'string' && !enumerationSites.has(callerSite()?.site)) env.add(key);
};
const traced = new Proxy(realEnv, {
  get(target, key) {
    read(key);
    return Reflect.get(target, key);
  },
  has(target, key) {
    read(key);
    return Reflect.has(target, key);
  },
  getOwnPropertyDescriptor(target, key) {
    read(key);
    return Reflect.getOwnPropertyDescriptor(target, key);
  },
  set(target, key, value) {
    return Reflect.set(target, key, value);
  },
  ownKeys(target) {
    const caller = active ? callerSite() : null;
    if (caller) {
      enumerationSites.add(caller.site);
      if (!caller.internal) enumerators.add(caller.file);
    }
    return Reflect.ownKeys(target);
  },
});
Object.defineProperty(process, 'env', { value: traced, writable: true, configurable: true, enumerable: true });

function escape(label, owner, name) {
  const original = owner[name];
  if (typeof original !== 'function') return;
  owner[name] = function (...args) {
    if (active) opaque.add(`${label}.${name}`);
    return original.apply(this, args);
  };
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
  escape('child_process', require('node:child_process'), name);
for (const [id, name] of [
  ['net', 'connect'],
  ['net', 'createConnection'],
  ['http', 'request'],
  ['https', 'request'],
])
  escape(id, require(`node:${id}`), name);
escape('globalThis', globalThis, 'fetch');
escape('process', process, 'dlopen');
Module.syncBuiltinESMExports();

const compile = Module.prototype['_compile'];
Module.prototype['_compile'] = function (content, filename, ...rest) {
  if (active && !modules.has(filename)) modules.set(filename, sha256(content));
  return compile.call(this, content, filename, ...rest);
};
const hooks = typeof Module.registerHooks === 'function';
if (hooks)
  Module.registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (active && url.startsWith('file:') && result.source != null) {
        const file = fileURLToPath(url);
        if (!modules.has(file)) modules.set(file, sha256(result.source));
      }
      return result;
    },
  });

process.on('exit', () => {
  active = false;
  const trace = JSON.stringify({
    env: [...env],
    enumerators: [...enumerators],
    reads: [...reads.values()],
    modules: [...modules].map(([file, hash]) => ({ path: file, hash })),
    opaque: [...opaque, ...(hooks ? [] : ['module.registerHooks missing'])],
  });
  const bytes = Buffer.from(trace);
  for (let offset = 0; offset < bytes.length;) {
    try {
      offset += fs.writeSync(TRACE_FD, bytes, offset);
    } catch (error) {
      if (error.code !== 'EAGAIN') return;
    }
  }
});
