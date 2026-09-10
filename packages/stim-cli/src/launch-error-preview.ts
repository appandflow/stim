import { stripAnsi } from './process-output.ts';

type RecordLike = { msg?: unknown; stack?: unknown; componentStack?: unknown; [key: string]: unknown };
type StackKind = 'Error' | 'Component' | 'Native' | 'Caused-by';

function framePriority(frame: string, root?: string): number {
  const normalized = frame.replaceAll('\\', '/');
  if (/^\s*at (?:android\.|java\.|com\.android\.|dalvik\.)/.test(normalized)) return 2;
  if (/(?:^|[/(\s])node_modules\//.test(normalized) || /\bnode:internal\//.test(normalized)) return 2;
  const paths = [
    ...normalized.matchAll(
      /(?:\(|@|\bat )([^()]+?\.(?:[cm]?[jt]sx?|swift|kt|java|mm?|cpp|cc|c|h))(?::\d+(?::\d+)?)?(?:\)|$)/g,
    ),
  ];
  for (const [, file] of paths) {
    if (!file || /^https?:/.test(file)) continue;
    const absolute = file.startsWith('/') || /^[A-Za-z]:\//.test(file);
    if (!absolute && !file.startsWith('../')) return 0;
    if (root && file.startsWith(`${root.replaceAll('\\', '/').replace(/\/$/, '')}/`)) return 0;
  }
  if (/\(<anonymous>\)\s*$/.test(frame)) return 2;
  return 1;
}

function decodeStack(value: string): string {
  return value.replace(/\\([nrt\\'"])/g, (_escape, char: string) => {
    return ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[char] ?? char;
  });
}

function expandStackFields(message: string): string {
  const expanded = message.replace(
    /(?<!\w)(['"]?)(componentStack|stack)\1:\s*(['"])((?:\\.|(?!\3)[^\\])*)\3,?/g,
    (_match, _keyQuote: string, field: string, _quote: string, value: string) => {
      return `\n${field === 'componentStack' ? 'Component' : 'Error'} stack:\n${decodeStack(value)}\n`;
    },
  );
  return expanded.replace(
    /(^|\n|[,{])[ \t]*(['"]?)(componentStack|stack)\2:[ \t]*(['"])((?:\\.|[^\\\n])*)$/gm,
    (match, prefix: string, _keyQuote: string, field: string, _quote: string, value: string) => {
      if (!/\\n\s+at\s/.test(value)) return match;
      return `${prefix}\n${field === 'componentStack' ? 'Component' : 'Error'} stack:\n${decodeStack(value)}`;
    },
  );
}

function jsonStringField(blob: string, field: string): string | null {
  const match = new RegExp(`"${field}":"((?:[^"\\\\]|\\\\.)*)"`).exec(blob);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

function jsonObjectComplete(blob: string): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < blob.length; i++) {
    const char = blob[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return true;
  }
  return false;
}

/**
 * React Native's DebugServerException embeds Metro's serialized bundling error
 * after a `Body:` line, and logcat splits that JSON across lines past 4 KiB.
 */
function compactMetroErrorBody(
  text: string,
  root: string | undefined,
  printed: readonly string[],
): { head: string; lines: string[]; tail: string } | null {
  if (!text.includes('DebugServerException')) return null;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes('{"type":"'));
  if (start < 0) return null;
  const prefix = lines[start]!.slice(0, lines[start]!.indexOf('{"type":"'));
  let blob = lines[start]!.slice(prefix.length);
  let end = start + 1;
  while (
    end < lines.length &&
    !jsonObjectComplete(blob) &&
    lines[end]!.trim() &&
    !/^(?:\tat\s|\s*Caused by:)/.test(lines[end]!)
  )
    blob += lines[end++]!;
  const type = /^\{"type":"([^"]*)"/.exec(blob)?.[1];
  const message = jsonStringField(blob, 'message');
  if (!type || !message) return null;
  const stripRoot = (value: string) => (root ? value.replaceAll(`${root}/`, '') : value);
  const [firstLine = '', ...rest] = stripRoot(stripAnsi(message)).trim().split(/\r?\n/);
  const first = firstLine.trim();
  const importStack = jsonStringField(blob, '_expoImportStack')?.trim();
  const replacement =
    first && printed.some((line) => stripRoot(line).trim() === first)
      ? [`${type}: ${first} (diagnosis above)`]
      : [`${type}: ${first}`, ...rest, ...(importStack ? importStack.split('\n') : [])];
  return {
    head: [...lines.slice(0, start), ...(prefix.trim() ? [prefix] : [])].join('\n'),
    lines: [...replacement, '[Metro error body compacted; full text in stim logs]'],
    tail: lines.slice(end).join('\n'),
  };
}

function shortFrame(frame: string, root?: string): string {
  const text = root ? frame.replaceAll(`${root}/`, '') : frame;
  const compact = text
    .trim()
    .replace(/ \(BuildId: [0-9a-f]+\)/gi, '')
    .replace(' [captured native frame]', '')
    .replace(/ \(in ([^()]+)\) \(\/?<compiler-generated>:0\) \(\1\)$/, ' ($1; compiler-generated)')
    .replace(/https?:\/\/[^\s)]+/g, (location) => {
      const match = /^(.*\.bundle)(?:[^\s]*?)(:\d+:\d+)$/.exec(location);
      if (!match) {
        const bundle = /\/([^/]+\.bundle)/.exec(location)?.[1];
        return bundle ? `${bundle} [unsymbolicated]` : location;
      }
      return `${match[1]!.split('/').at(-1)}${match[2]} [unsymbolicated]`;
    });
  return compact.replace(/\((\/(?:apex|system)\/[^()]+)\)/g, (_match, path: string) => `(${path.split('/').at(-1)})`);
}

function structuredFrames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((frame: unknown) => {
    if (frame === null || typeof frame !== 'object') return [];
    const { file, line, column, fn } = frame as Record<string, unknown>;
    const location = [typeof file === 'string' ? file : null, line, column]
      .filter((part) => typeof part === 'string' || (typeof part === 'number' && Number.isFinite(part)))
      .join(':');
    const name = typeof fn === 'string' ? fn : '';
    return name && location ? [`at ${name} (${location})`] : name || location ? [`at ${name || location}`] : [];
  });
}

/** Formats captured stacks for humans; full mode removes preview limits and preserves frame text. */
export function launchErrorPreview(
  records: readonly RecordLike[],
  root?: string,
  { full = false }: { full?: boolean } = {},
): string[] {
  const lines: string[] = [];
  let kind: StackKind = 'Error';
  let frames: string[] = [];
  let hadStack = false;
  let source = '';
  const flush = () => {
    if (frames.length) {
      hadStack = true;
      const ranked = frames.map((frame, index) => ({ frame, index, rank: framePriority(frame, root) }));
      const selected = ranked
        .toSorted((a, b) => a.rank - b.rank || a.index - b.index)
        .slice(0, full ? undefined : 10)
        .toSorted((a, b) => a.index - b.index);
      const prioritized = !full && selected.some(({ index, rank }) => index >= 10 && rank === 0);
      lines.push(
        `${kind} stack${prioritized ? ' (app frames prioritized)' : ''}:`,
        ...selected.map(({ frame }) => `  ${full ? frame.trim() : shortFrame(frame, root)}`),
      );
      if (frames.length > selected.length) {
        const frameworkCount = ranked.filter((entry) => entry.rank === 2 && !selected.includes(entry)).length;
        lines.push(
          `  ... ${frames.length - selected.length} more frames${frameworkCount ? ` (${frameworkCount} dependency/native)` : ''}`,
        );
      }
    }
    frames = [];
    kind = 'Error';
  };
  const consume = (line: string) => {
    if ((hadStack || frames.length > 0) && /^\s*isComponentError:\s*(?:true|false)\s*}?,?\s*$/.test(line)) return;
    const header = /^\s*(Component stack|Error stack|Call Stack):?\s*$/i.exec(line);
    if (header) {
      flush();
      kind = /^component/i.test(header[1]!) ? 'Component' : 'Error';
    } else if (
      /^\s*at\s+\S/.test(line) ||
      /^\s*\S[^\n]*@\S+:\d+:\d+\s*$/.test(line) ||
      /^\s+\S[^\n]*\([^()]+:\d+:\d+\)\s*$/.test(line)
    ) {
      if (!full && /\(https?:\/\/[^\s)]*$/.test(line)) return;
      frames.push(line);
    } else if (line.trim()) {
      flush();
      if (/^\s*Caused by:/.test(line)) kind = 'Caused-by';
      lines.push(
        !full && line.length > 1000 ? `${line.slice(0, 1000)} ... [preview shortened; full text in stim logs]` : line,
      );
    }
  };
  for (const record of records) {
    const nextSource = JSON.stringify([record.src, record.platform, record.proc]);
    if (source !== nextSource) flush();
    source = nextSource;
    if (record.msg != null) {
      const msg = String(record.msg);
      const compacted = full ? null : compactMetroErrorBody(msg, root, lines);
      const chunks = compacted
        ? [expandStackFields(compacted.head), ...compacted.lines, expandStackFields(compacted.tail)]
        : [expandStackFields(msg)];
      for (const chunk of chunks) for (const line of chunk.split(/\r?\n/)) consume(line);
    }
    const stack = typeof record.stack === 'string' ? record.stack.split(/\r?\n/) : structuredFrames(record.stack);
    if (stack.length) {
      flush();
      if (record.event === 'native_crash') kind = 'Native';
      for (const line of stack) consume(line);
    }
    const components =
      typeof record.componentStack === 'string'
        ? record.componentStack.split(/\r?\n/)
        : structuredFrames(record.componentStack);
    if (components.length) {
      flush();
      kind = 'Component';
      for (const line of components) consume(line);
    }
    if (typeof record.codeFrame === 'string') {
      flush();
      lines.push(record.codeFrame);
    }
    if (typeof record.symbolicationNote === 'string') {
      flush();
      lines.push(
        ...record.symbolicationNote.split('\n').filter((line) => full || !line.startsWith('Same error captured by ')),
      );
    }
  }
  flush();
  if (hadStack && !full) lines.push('Full captured logs: stim logs --source all');
  return lines;
}
