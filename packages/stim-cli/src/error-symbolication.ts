import type { NdjsonRecord } from './ndjson.ts';

interface Frame {
  file: string;
  lineNumber: number;
  column: number;
  methodName: string;
}

const LOCATION = /https?:\/\/[^\s)'"\\]+?:\d+:\d+/g;

function frameFromLocation(location: string): Frame | null {
  const match = /^(https?:\/\/.+):(\d+):(\d+)$/.exec(location);
  if (!match) return null;
  const file = match[1]!;
  if (!/\.bundle(?:[/?]|$)/.test(file)) return null;
  const lineNumber = Number(match[2]);
  const column = Number(match[3]) - 1;
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || !Number.isSafeInteger(column) || column < 0) return null;
  return { file, lineNumber, column, methodName: '<unknown>' };
}

export function bundleLocations(record: NdjsonRecord): string[] {
  const text = [record.msg, record.stack, record.componentStack]
    .filter((value) => typeof value === 'string')
    .join('\n');
  const found = [...text.matchAll(LOCATION)].map(([location]) => location);
  for (const value of [record.stack, record.componentStack]) {
    if (!Array.isArray(value)) continue;
    for (const frame of value) {
      if (
        frame &&
        typeof frame.file === 'string' &&
        typeof frame.line === 'number' &&
        typeof frame.column === 'number'
      ) {
        found.push(`${frame.file}:${frame.line}:${frame.column + 1}`);
      }
    }
  }
  return [...new Set(found)].filter((location) => frameFromLocation(location) !== null);
}

/** Resolves captured bundle coordinates against the already-verified workspace Metro. */
export async function symbolicateErrors(
  records: readonly NdjsonRecord[],
  { port, timeoutMs = 2000, request = fetch }: { port: number | null; timeoutMs?: number; request?: typeof fetch },
): Promise<NdjsonRecord[]> {
  const candidates = [...new Set(records.flatMap(bundleLocations))].slice(0, 200);
  if (!candidates.length) return [...records];
  const fallback = (reason: string) =>
    records.map((record) =>
      bundleLocations(record).length
        ? { ...record, symbolicationNote: `JS symbolication unavailable (${reason}); captured coordinates retained.` }
        : record,
    );
  if (!Number.isInteger(port) || !port || port < 1 || port > 65535) return fallback('no verified Metro');
  try {
    const response = await request(`http://127.0.0.1:${port}/symbolicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: candidates.map(frameFromLocation) }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) return fallback(`HTTP ${response.status}`);
    const body = (await response.json()) as { stack?: unknown };
    if (!Array.isArray(body.stack) || body.stack.length !== candidates.length)
      return fallback('invalid Metro response');
    const resolved = new Map<string, string>();
    for (let index = 0; index < candidates.length; index++) {
      const frame: unknown = body.stack[index];
      if (!frame || typeof frame !== 'object') continue;
      const { file, lineNumber, column } = frame as Partial<Frame>;
      if (
        typeof file !== 'string' ||
        /[\r\n]/.test(file) ||
        /^https?:/.test(file) ||
        !Number.isSafeInteger(lineNumber) ||
        lineNumber! < 1 ||
        !Number.isSafeInteger(column) ||
        column! < 0
      )
        continue;
      resolved.set(candidates[index]!, `${file}:${lineNumber}:${column! + 1}`);
    }
    return records.map((record) => {
      const matches = bundleLocations(record);
      if (!matches.length) return record;
      const replace = (value: unknown): unknown => {
        if (typeof value === 'string') return value.replace(LOCATION, (location) => resolved.get(location) ?? location);
        if (!Array.isArray(value)) return value;
        return value.map((frame) => {
          if (!frame || typeof frame !== 'object') return frame;
          const mapped = resolved.get(`${frame.file}:${frame.line}:${frame.column + 1}`);
          const match = mapped && /^(.*):(\d+):(\d+)$/.exec(mapped);
          return match ? { ...frame, file: match[1], line: Number(match[2]), column: Number(match[3]) - 1 } : frame;
        });
      };
      return {
        ...record,
        ...(record.msg !== undefined ? { msg: replace(record.msg) as string } : {}),
        ...(record.stack !== undefined ? { stack: replace(record.stack) } : {}),
        ...(record.componentStack !== undefined ? { componentStack: replace(record.componentStack) } : {}),
        ...(matches.some((location) => !resolved.has(location))
          ? { symbolicationNote: 'Some JS frames remain unsymbolicated; captured coordinates retained.' }
          : {}),
      };
    });
  } catch {
    return fallback('request failed or timed out');
  }
}
