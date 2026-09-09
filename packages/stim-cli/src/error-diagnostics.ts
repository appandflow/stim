import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NdjsonRecord } from './ndjson.ts';
import { bundleLocations, symbolicateErrors } from './error-symbolication.ts';
import { resolveProjectMetro } from './metro.ts';
import { attachExpoErrorContext, readLogRecords } from './logs-query.ts';
import { writeDiagnosticOnce } from './diagnostic-store.ts';

function key(record: NdjsonRecord): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function errorTitle(record: NdjsonRecord): string | null {
  const line = String(record.msg ?? '')
    .split('\n')[0]!
    .trim()
    .replace(/^ERROR\s+/, '');
  const match = /^(?:\{\s*)?\[?((?:\w*Error|\w*Exception): .+?)\]?$/.exec(line);
  return match?.[1] ?? null;
}

function identity(record: NdjsonRecord): string {
  return JSON.stringify([record.src, record.ts, record.proc, record.msg]);
}

function attachDeviceErrorContext(timeline: NdjsonRecord[], selected: NdjsonRecord[]): NdjsonRecord[] {
  const consumed = new Set<string>();
  const rendered = selected.map((record) => {
    if (record.src !== 'device' || !errorTitle(record) || !record.proc) return record;
    const index = timeline.findIndex((entry) => identity(entry) === identity(record));
    if (index < 0) return record;
    const context: string[] = [];
    for (const next of timeline.slice(index + 1)) {
      if (Number(next.ts) - Number(record.ts) > 1000 || context.length >= 10) break;
      if (next.src !== 'device' || next.proc !== record.proc || next.platform !== record.platform) continue;
      if (!/^\s*(?:(?:componentStack|stack):\s*['"]|isComponentError:|[{}],?$)/.test(next.msg ?? '')) break;
      context.push(String(next.msg));
      consumed.add(identity(next));
    }
    return context.length ? { ...record, msg: [record.msg, ...context].join('\n') } : record;
  });
  return rendered.filter((_record, index) => !consumed.has(identity(selected[index]!)));
}

/** Collapses only cross-source copies with the same error title and a shared stack location. */
export function mergeErrorCopies(records: readonly NdjsonRecord[], root?: string): NdjsonRecord[] {
  const result: NdjsonRecord[] = [];
  for (const record of records) {
    if (record.event === 'native_crash' && record.pid) {
      const duplicate = result.findIndex(
        (other) =>
          other.event === 'native_crash' &&
          other.pid === record.pid &&
          other.deviceId === record.deviceId &&
          other.appId === record.appId &&
          Math.abs(Number(other.ts) - Number(record.ts)) < 5000,
      );
      if (duplicate >= 0) {
        const prior = result[duplicate]!;
        const full = Array.isArray(record.stack) ? record : prior;
        const consoleRecord = full === record ? prior : record;
        result[duplicate] = {
          ...full,
          msg: full.msg === consoleRecord.msg ? full.msg : `${consoleRecord.msg}\n${full.msg}`,
        };
        continue;
      }
    }
    const title = errorTitle(record);
    const locations = new Set(
      [
        ...JSON.stringify([record.msg, record.stack, record.componentStack])
          .replaceAll(root ? `${root}/` : '\u0000', '')
          .matchAll(/[^\s()"\\]+:\d+:\d+/g),
      ].map(([location]) => location),
    );
    const existing =
      title && locations.size
        ? result.findIndex(
            (other) =>
              !(Array.isArray(other.mirroredSources) ? other.mirroredSources : [other.src]).includes(record.src) &&
              (!other.platform || !record.platform || other.platform === record.platform) &&
              errorTitle(other) === title &&
              typeof other.ts === 'number' &&
              typeof record.ts === 'number' &&
              Math.abs(other.ts - record.ts) < 1000 &&
              [
                ...JSON.stringify([other.msg, other.stack, other.componentStack])
                  .replaceAll(root ? `${root}/` : '\u0000', '')
                  .matchAll(/[^\s()"\\]+:\d+:\d+/g),
              ].some(([location]) => locations.has(location)),
          )
        : -1;
    if (existing < 0) result.push(record);
    else {
      const prior = result[existing]!;
      const richer = JSON.stringify(record).length > JSON.stringify(prior).length ? record : prior;
      const other = richer === record ? prior : record;
      const sources = [
        ...new Set([...(Array.isArray(prior.mirroredSources) ? prior.mirroredSources : [prior.src]), record.src]),
      ];
      result[existing] = {
        ...richer,
        src: prior.src,
        ts: prior.ts,
        platform: prior.platform ?? record.platform,
        ...(richer.stack || other.stack ? { stack: richer.stack ?? other.stack } : {}),
        ...(richer.componentStack || other.componentStack
          ? { componentStack: richer.componentStack ?? other.componentStack }
          : {}),
        msg:
          /\bCall Stack\b/.test(String(other.msg)) && /componentStack/.test(String(richer.msg))
            ? `${other.msg}\n${String(richer.msg).replace(/^[^\n]*\n/, '')}`
            : richer.msg,
        mirroredSources: sources,
        symbolicationNote: [
          richer.symbolicationNote,
          `Same error captured by ${sources.join(' + ')}; raw copies retained in logs --json.`,
        ]
          .filter(Boolean)
          .join(' '),
      };
    }
  }
  return result;
}

/** Keeps symbolicated launch evidence stable when Metro later rebuilds or stops. */
export async function errorDiagnostics(
  input: readonly Record<string, unknown>[],
  {
    root,
    logsDir,
    port,
    allowRequest = false,
  }: { root: string; logsDir: string; port: number | null; allowRequest?: boolean },
): Promise<NdjsonRecord[]> {
  const timeline = readLogRecords(logsDir);
  const records = attachDeviceErrorContext(
    timeline,
    attachExpoErrorContext(
      timeline,
      input.map((record) => ({
        ...record,
        src: typeof record.src === 'string' ? record.src : undefined,
        msg: record.msg == null ? undefined : String(record.msg),
        level: typeof record.level === 'string' ? record.level : undefined,
        ts: typeof record.ts === 'number' ? record.ts : undefined,
      })),
    ),
  );
  const requestedCount = records.length;
  const related = timeline
    .filter(
      (candidate) =>
        candidate.src === 'device' &&
        records.some(
          (record) =>
            record.src !== 'device' &&
            errorTitle(record) &&
            errorTitle(record) === errorTitle(candidate) &&
            Math.abs(Number(record.ts) - Number(candidate.ts)) < 1000 &&
            (!record.platform || !candidate.platform || record.platform === candidate.platform),
        ) &&
        !records.some(
          (record) => record.src === candidate.src && record.ts === candidate.ts && record.msg === candidate.msg,
        ),
    )
    .slice(-100);
  records.push(...attachDeviceErrorContext(timeline, related));
  const directory = join(logsDir, 'error-context');
  const rendered = records.map((record) => {
    try {
      const saved = JSON.parse(readFileSync(join(directory, `${key(record)}.json`), 'utf8')) as {
        original?: string;
        rendered?: NdjsonRecord;
      };
      return saved.original === key(record) && saved.rendered && typeof saved.rendered === 'object'
        ? saved.rendered
        : record;
    } catch {
      return record;
    }
  });
  if (allowRequest && port && (await resolveProjectMetro(port, root)).metro) {
    const pending = records.flatMap((record, index) => {
      if (rendered[index] !== record) return [];
      const rebuilt = timeline.some(
        (event) =>
          ['bundle_build_started', 'server_started', 'supervisor_started'].includes(String(event.event)) &&
          Number(event.ts) > Number(record.ts) &&
          (!event.platform || !record.platform || event.platform === record.platform),
      );
      if (rebuilt && bundleLocations(record).length) {
        rendered[index] = {
          ...record,
          symbolicationNote:
            'Metro rebuilt after this error; captured coordinates retained rather than mapping against a different bundle.',
        };
        return [];
      }
      return [{ record, index }];
    });
    const resolved = await symbolicateErrors(
      pending.map(({ record }) => record),
      { port },
    );
    for (let index = 0; index < pending.length; index++) {
      const entry = pending[index]!;
      const value = resolved[index]!;
      rendered[entry.index] = value;
      if (bundleLocations(value).length === bundleLocations(entry.record).length) continue;
      try {
        writeDiagnosticOnce(
          join(directory, `${key(entry.record)}.json`),
          JSON.stringify({ original: key(entry.record), rendered: value }),
        );
      } catch {}
    }
  }
  let merged = mergeErrorCopies(rendered.slice(0, requestedCount), root);
  for (const candidate of rendered.slice(requestedCount)) {
    const combined = mergeErrorCopies([...merged, candidate], root);
    if (combined.length === merged.length) merged = combined;
  }
  return merged;
}
