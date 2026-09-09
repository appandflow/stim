type RecordLike = { msg?: unknown; stack?: unknown; componentStack?: unknown; [key: string]: unknown };
type StackKind = 'Error' | 'Component';

function decodeStack(value: string): string {
  return value.replace(/\\([nrt\\'"])/g, (_escape, char: string) => {
    return ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[char] ?? char;
  });
}

function expandStackFields(message: string): string {
  const expanded = message.replace(
    /\b(componentStack|stack):\s*(['"])((?:\\.|(?!\2)[^\\])*)\2,?/g,
    (_match, field: string, _quote: string, value: string) => {
      return `${field === 'componentStack' ? 'Component' : 'Error'} stack:\n${decodeStack(value)}\n`;
    },
  );
  return expanded.replace(
    /(^|\n)[ \t]*(componentStack|stack):[ \t]*(['"])((?:\\.|[^\\\n])*)$/g,
    (match, prefix: string, field: string, _quote: string, value: string) => {
      if (!/\\n\s+at\s/.test(value)) return match;
      return `${prefix}${field === 'componentStack' ? 'Component' : 'Error'} stack:\n${decodeStack(value)}\n[captured stack text is incomplete]`;
    },
  );
}

function shortFrame(frame: string): string {
  return frame.trim().replace(/https?:\/\/[^\s)]+/g, (location) => {
    const match = /^(.*\.bundle)(?:[^\s]*?)(:\d+:\d+)$/.exec(location);
    if (!match) return location;
    return `${match[1]!.split('/').at(-1)}${match[2]} [unsymbolicated]`;
  });
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

/** Formats a bounded human launch preview without changing captured records. */
export function launchErrorPreview(records: readonly RecordLike[]): string[] {
  const lines: string[] = [];
  let kind: StackKind = 'Error';
  let frames: string[] = [];
  let hadStack = false;
  let source = '';
  const flush = () => {
    if (frames.length) {
      hadStack = true;
      const limit = kind === 'Component' ? 3 : 5;
      lines.push(`${kind} stack:`, ...frames.slice(0, limit).map((frame) => `  ${shortFrame(frame)}`));
      if (frames.length > limit) lines.push(`  ... ${frames.length - limit} more frames`);
    }
    frames = [];
    kind = 'Error';
  };
  const consume = (line: string) => {
    const header = /^\s*(Component stack|Error stack|Call Stack):?\s*$/i.exec(line);
    if (header) {
      flush();
      kind = /^component/i.test(header[1]!) ? 'Component' : 'Error';
    } else if (
      /^\s*at\s+\S/.test(line) ||
      /^\s*\S[^\n]*@\S+:\d+:\d+\s*$/.test(line) ||
      /^\s+\S[^\n]*\([^()]+:\d+:\d+\)\s*$/.test(line)
    ) {
      frames.push(line);
    } else if (line.trim()) {
      flush();
      lines.push(line);
    }
  };
  for (const record of records) {
    const nextSource = JSON.stringify([record.src, record.platform, record.proc]);
    if (source !== nextSource) flush();
    source = nextSource;
    if (record.msg != null) {
      for (const line of expandStackFields(String(record.msg)).split(/\r?\n/)) consume(line);
    }
    const stack = typeof record.stack === 'string' ? record.stack.split(/\r?\n/) : structuredFrames(record.stack);
    if (stack.length) {
      flush();
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
  }
  flush();
  if (hadStack) lines.push('Full captured stacks: stim logs --source all (add --json for raw records)');
  return lines;
}
