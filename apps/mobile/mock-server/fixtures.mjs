import { readFileSync } from 'node:fs';

const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'];
const ERROR_SOURCES = ['metro', 'client', 'build'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);

export function loadFixtures() {
  const status = JSON.parse(readFileSync(fixture('status.json'), 'utf8'));
  const logs = readFileSync(fixture('logs.ndjson'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const frame = JSON.parse(readFileSync(fixture('frame-ios.json'), 'utf8'));
  return {
    capturedAt: status.capturedAt,
    stimVersion: status.stimVersion,
    home: status.home,
    status: status.payload,
    logs,
    frames: {
      ios: { ...frame, data: readFileSync(fixture('frame-ios.jpg')).toString('base64') },
    },
  };
}

/** Moves every ISO timestamp in a captured payload forward, so durations read as they did at capture. */
export function shiftTimestamps(value, deltaMs) {
  if (typeof value === 'string' && ISO.test(value)) return new Date(Date.parse(value) + deltaMs).toISOString();
  if (Array.isArray(value)) return value.map((item) => shiftTimestamps(item, deltaMs));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shiftTimestamps(item, deltaMs)]));
  }
  return value;
}

const rank = (level) => Math.max(0, LEVELS.indexOf(level));

/** The `stim logs` record filter (packages/stim-cli/src/diagnostics/logs-query.ts) without launch markers. */
export function filterRecords(records, params) {
  const sources = params.sources?.length ? params.sources : params.errors ? ERROR_SOURCES : null;
  const grep = params.grep ? new RegExp(params.grep) : null;
  const out = records.filter((record) => {
    if (params.slot !== undefined && (record.slot ?? 'default') !== params.slot) return false;
    const nativeCrash =
      params.errors && !params.sources?.length && record.src === 'device' && record.event === 'native_crash';
    if (sources && !sources.includes(record.src) && !nativeCrash) return false;
    if (params.level && rank(record.level) < rank(params.level)) return false;
    if (params.errors && record.level !== 'error' && record.level !== 'fatal') return false;
    if (grep && !grep.test(String(record.msg ?? ''))) return false;
    return true;
  });
  return params.tail ? out.slice(-params.tail) : out;
}
