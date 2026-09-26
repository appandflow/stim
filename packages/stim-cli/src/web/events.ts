import type { NdjsonRecord } from '../ndjson.ts';

interface ObjectPreview {
  subtype?: string;
  overflow?: boolean;
  properties?: { name: string; type?: string; value?: string }[];
}

interface RemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  preview?: ObjectPreview;
}

interface CallFrame {
  functionName?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}

interface StackFrame {
  file: string | null;
  line: number | null;
  column: number | null;
  fn: string | null;
}

const MAX_FRAMES = 20;

const CONSOLE_LEVELS: Record<string, string> = {
  debug: 'debug',
  log: 'info',
  info: 'info',
  dir: 'info',
  table: 'info',
  trace: 'info',
  warning: 'warn',
  error: 'error',
  assert: 'error',
};

const LOG_ENTRY_LEVELS: Record<string, string> = { verbose: 'debug', info: 'info', warning: 'warn', error: 'error' };

function describeArg(arg: RemoteObject): string {
  if (arg.type === 'string') return String(arg.value);
  if (arg.unserializableValue !== undefined) return arg.unserializableValue;
  if (arg.type === 'undefined') return 'undefined';
  if (arg.value !== undefined) return typeof arg.value === 'object' ? JSON.stringify(arg.value) : String(arg.value);
  if (arg.type === 'object' && arg.subtype !== 'error' && arg.preview?.properties) {
    return describePreview(arg.preview, arg.subtype ?? arg.preview.subtype);
  }
  return arg.description ?? arg.type ?? '';
}

function describePreview(preview: ObjectPreview, subtype: string | undefined): string {
  const array = subtype === 'array';
  const entries = (preview.properties ?? []).map((property) => {
    const value = property.type === 'string' ? JSON.stringify(property.value ?? '') : (property.value ?? '');
    return array ? value : `${property.name}: ${value}`;
  });
  if (preview.overflow) entries.push('...');
  return array ? `[${entries.join(', ')}]` : `{${entries.join(', ')}}`;
}

function frames(stackTrace: unknown): StackFrame[] {
  const callFrames = (stackTrace as { callFrames?: CallFrame[] } | undefined)?.callFrames;
  if (!Array.isArray(callFrames)) return [];
  return callFrames.slice(0, MAX_FRAMES).map((frame) => ({
    file: frame.url || null,
    line: typeof frame.lineNumber === 'number' ? frame.lineNumber + 1 : null,
    column: typeof frame.columnNumber === 'number' ? frame.columnNumber + 1 : null,
    fn: frame.functionName || null,
  }));
}

function withStack(record: NdjsonRecord, stack: StackFrame[]): NdjsonRecord {
  return stack.length ? { ...record, stack } : record;
}

/** `Runtime.consoleAPICalled`: a console call in the page, as a `client` record. */
export function consoleRecord(params: Record<string, unknown>): NdjsonRecord {
  const type = String(params.type ?? 'log');
  const args = Array.isArray(params.args) ? (params.args as RemoteObject[]) : [];
  return withStack(
    {
      src: 'client',
      platform: 'web',
      level: CONSOLE_LEVELS[type] ?? 'info',
      msg: args.map(describeArg).join(' '),
    },
    type === 'error' || type === 'assert' || type === 'trace' ? frames(params.stackTrace) : [],
  );
}

/** `Runtime.exceptionThrown`: an uncaught error or rejected promise in the page, as a `client` error. */
export function exceptionRecord(params: Record<string, unknown>): NdjsonRecord {
  const details = (params.exceptionDetails ?? {}) as {
    text?: string;
    exception?: RemoteObject;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
    stackTrace?: unknown;
  };
  const description = (details.exception?.description ?? describeArg(details.exception ?? {})).split('\n')[0];
  const prefix = details.text ?? 'Uncaught';
  const text = description ? `${prefix} ${description}` : prefix;
  const stack = frames(details.stackTrace);
  return withStack(
    {
      src: 'client',
      platform: 'web',
      level: 'error',
      event: 'web_exception',
      msg: text,
    },
    stack.length
      ? stack
      : details.url
        ? [
            {
              file: details.url,
              line: typeof details.lineNumber === 'number' ? details.lineNumber + 1 : null,
              column: typeof details.columnNumber === 'number' ? details.columnNumber + 1 : null,
              fn: null,
            },
          ]
        : [],
  );
}

/**
 * `Log.entryAdded`: a message the browser itself logged, such as a CSP or mixed-content violation. Null for its
 * `network` entries, which repeat the failed requests the Network domain already reports.
 */
export function logEntryRecord(params: Record<string, unknown>): NdjsonRecord | null {
  const entry = (params.entry ?? {}) as { level?: string; text?: string; url?: string; source?: string };
  if (entry.source === 'network') return null;
  const where = entry.url ? ` (${entry.url})` : '';
  return {
    src: 'device',
    platform: 'web',
    level: LOG_ENTRY_LEVELS[entry.level ?? ''] ?? 'info',
    event: 'web_browser_log',
    msg: `${entry.source ? `${entry.source}: ` : ''}${entry.text ?? ''}${where}`,
  };
}

/** A request the page made that failed to load or answered with an HTTP error. */
export function networkFailureRecord({
  url,
  method,
  errorText,
  status,
  canceled,
  document,
}: {
  url: string;
  method: string;
  errorText?: string;
  status?: number;
  canceled?: boolean;
  document: boolean;
}): NdjsonRecord {
  const failure = status === undefined ? (errorText ?? 'failed') : `HTTP ${status}`;
  return {
    src: 'device',
    platform: 'web',
    level: canceled ? 'debug' : document || status === undefined || status >= 500 ? 'error' : 'warn',
    event: canceled ? 'web_request_canceled' : document ? 'web_document_failed' : 'web_request_failed',
    ...(status === undefined ? {} : { status }),
    msg: `${method} ${url} ${canceled ? 'canceled' : `failed: ${failure}`}`,
  };
}
