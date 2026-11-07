'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

function absoluteEnvPath(name) {
  const value = process.env[name];
  if (!value) return null;
  if (path.isAbsolute(value)) return value;
  return null;
}

function configDir() {
  return absoluteEnvPath('STIM_HOME') || path.join(os.homedir(), '.stim');
}

function workspaceSlug(projectRoot) {
  const name = path
    .basename(path.resolve(projectRoot))
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 48);
  return name || 'workspace';
}

function workspaceId(projectRoot) {
  return createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
}

function workspaceName(projectRoot) {
  return `${workspaceSlug(projectRoot)}--${workspaceId(projectRoot)}`;
}

function workspaceStateDir(projectRoot) {
  return path.join(configDir(), 'workspaces', workspaceName(projectRoot));
}

function workspaceLogDir(projectRoot) {
  return path.join(workspaceStateDir(projectRoot), 'logs');
}

const LOG_ROTATE_BYTES = 8 * 1024 * 1024;
function rotateLog(file, maxBytes) {
  if (logSize(file) < maxBytes) return;
  // No cross-process lock: concurrent rotation can drop one rotated generation, acceptable for a debug log.
  try {
    fs.renameSync(file, file + '.1');
  } catch {}
}

function logSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

const ANSI_ESCAPE = new RegExp(
  [String.raw`\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)`, String.raw`\u001b\[[0-?]*[ -/]*[@-~]`].join('|'),
  'g',
);
function stripAnsi(text) {
  return text.replace(ANSI_ESCAPE, '');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const NDJSON_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal']);
function ndjsonLevel(level, fallback) {
  const value = String(level === undefined || level === null ? '' : level).toLowerCase();
  if (NDJSON_LEVELS.has(value)) return value;
  switch (value) {
    case 'log':
    case 'dir':
    case 'table':
    case 'group':
    case 'groupcollapsed':
    case 'groupend':
      return 'info';
    case 'trace':
      return 'debug';
    case 'warning':
      return 'warn';
    default:
      return fallback;
  }
}

function formatValue(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || String(value);
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {}
  try {
    return String(value);
  } catch {
    return '[unprintable]';
  }
}

function formatData(data) {
  if (data === undefined || data === null) return '';
  if (Array.isArray(data)) return data.map(formatValue).join(' ');
  return formatValue(data);
}

function errorMessage(error) {
  if (error === undefined || error === null) return 'unknown error';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message) {
    return error.message;
  }
  return formatValue(error);
}

function symbolicationMessage(codeFrame) {
  if (!isPlainObject(codeFrame) || typeof codeFrame.content !== 'string') return 'Call Stack';
  const fileName = typeof codeFrame.fileName === 'string' ? codeFrame.fileName : 'unknown source';
  const location = isPlainObject(codeFrame.location) ? codeFrame.location : null;
  const row = typeof location?.row === 'number' ? `:${location.row}` : '';
  const column = typeof location?.column === 'number' ? `:${location.column}` : '';
  return `Code: ${fileName}${row}${column}\n${codeFrame.content}\nCall Stack`;
}

function symbolicationStack(stack) {
  if (!Array.isArray(stack)) return [];
  return stack
    .filter((frame) => isPlainObject(frame) && frame.collapse !== true)
    .map((frame) => {
      const normalized = {};
      if (typeof frame.file === 'string') normalized.file = frame.file;
      if (typeof frame.lineNumber === 'number') normalized.line = frame.lineNumber;
      if (typeof frame.column === 'number') normalized.column = frame.column;
      if (typeof frame.methodName === 'string') normalized.fn = frame.methodName;
      return normalized;
    })
    .filter((frame) => Object.keys(frame).length > 0);
}

function ndjsonReporter({ dir } = {}) {
  const logDir = dir || workspaceLogDir(process.cwd());
  let ensured = false;
  let drops = 0;
  const builds = new Map();
  let failedBuild = null;
  const uncheckedBytes = new Map();
  function write(file, record) {
    try {
      if (!ensured) {
        fs.mkdirSync(logDir, { recursive: true });
        ensured = true;
      }
      const target = path.join(logDir, file);
      // compat C6 permanent
      const inj = process.env.STIM_INJECTED_DIGEST;
      const line = JSON.stringify({ ...record, msg: stripAnsi(record.msg), ...(inj ? { inj } : {}) }) + '\n';
      // compat end
      const unchecked = uncheckedBytes.get(file);
      if (unchecked === undefined || unchecked >= LOG_ROTATE_BYTES / 8) {
        uncheckedBytes.set(file, 0);
        try {
          rotateLog(target, LOG_ROTATE_BYTES);
        } catch {}
      }
      fs.appendFileSync(target, line);
      uncheckedBytes.set(file, (uncheckedBytes.get(file) ?? 0) + Buffer.byteLength(line));
    } catch {
      drops += 1;
      ensured = false;
    }
  }
  function update(event) {
    try {
      const type = event && typeof event.type === 'string' ? event.type : '';
      const record = { ts: Date.now(), src: 'metro', level: 'debug', msg: '' };
      if (type) record.event = type;
      if (type !== 'bundling_error') failedBuild = null;
      if (type === 'bundle_build_started' && event.buildID) {
        const platform = event.bundleDetails?.platform || null;
        builds.set(event.buildID, platform);
        record.buildID = event.buildID;
        if (platform) record.platform = platform;
      } else if ((type === 'bundle_build_done' || type === 'bundle_build_failed') && event.buildID) {
        const platform = builds.get(event.buildID) || null;
        record.buildID = event.buildID;
        if (platform) record.platform = platform;
        builds.delete(event.buildID);
        if (type === 'bundle_build_failed') failedBuild = { buildID: event.buildID, platform };
      } else if (type === 'bundling_error' && failedBuild) {
        record.buildID = failedBuild.buildID;
        if (failedBuild.platform) record.platform = failedBuild.platform;
        failedBuild = null;
      }
      if (type === 'client_log') {
        record.src = 'client';
        record.level = ndjsonLevel(event.level, 'info');
        record.msg = formatData(event.data);
        if (event.stack) record.stack = event.stack;
        write('client.ndjson', record);
        return;
      }
      if (type === 'client_symbolication') {
        const stack = symbolicationStack(event.stack);
        const hasCodeFrame = isPlainObject(event.codeFrame) && typeof event.codeFrame.content === 'string';
        if (!hasCodeFrame && stack.length === 0) return;
        record.src = 'client';
        record.level = 'info';
        record.msg = symbolicationMessage(event.codeFrame);
        if (stack.length > 0) record.stack = stack;
        write('client.ndjson', record);
        return;
      }
      if (type === 'bundling_error' || type === 'transformer_error') {
        record.level = 'error';
        record.msg = errorMessage(event.error);
      } else if (type === 'bundle_build_done' || type === 'bundle_build_failed') {
        const what = type === 'bundle_build_done' ? 'bundle build done' : 'bundle build failed';
        record.level = 'info';
        record.msg = event.buildID ? `${what} (${event.buildID})` : what;
        record.marker = true;
      } else if (type === 'unstable_server_log') {
        record.level = ndjsonLevel(event.level, 'info');
        record.msg = formatData(event.data);
      } else {
        record.msg = formatData(event && event.data) || type || 'metro event';
      }
      write('metro.ndjson', record);
    } catch {
      drops += 1;
    }
  }
  return {
    dir: logDir,
    update,
    get drops() {
      return drops;
    },
  };
}

const HEARTBEAT_MS = 1000;

/**
 * Rewrites `file` every second with this process's pid, the time and `fields`, which tells stimd that this Metro's
 * event loop still runs. The timer does not keep the process alive.
 */
function startHeartbeat(file, fields = {}) {
  const beat = () => {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now(), ...fields }));
      fs.renameSync(tmp, file);
    } catch {}
  };
  beat();
  setInterval(beat, HEARTBEAT_MS).unref();
}

module.exports = { ndjsonReporter, startHeartbeat };
