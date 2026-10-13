const ESCAPES: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\t': '\\t', '\r': '\\r' };
const UNESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r' };

/**
 * One double-quoted word as systemd.syntax(7) reads it: C escapes inside the quotes, `%` doubled because unit files
 * expand specifiers, and in `ExecStart=` `$` doubled because systemd expands variables in command lines.
 */
export function quoteUnitWord(value: string, exec: boolean): string {
  const text = value.replace(/[\\"\n\t\r%$]/g, (char) =>
    char === '%' ? '%%' : char === '$' ? (exec ? '$$' : '$') : (ESCAPES[char] ?? char),
  );
  return `"${text}"`;
}

/** The words of a unit value `quoteUnitWord` wrote, or null when the value is not in that form. */
export function unitWords(line: string, exec: boolean): string[] | null {
  const out: string[] = [];
  const pattern = /\s*(?:"((?:[^"\\]|\\.)*)"|([^\s"]+))/y;
  let index = 0;
  while (index < line.length && line.slice(index).trim()) {
    pattern.lastIndex = index;
    const match = pattern.exec(line);
    if (!match) return null;
    index = pattern.lastIndex;
    const raw = match[1] ?? match[2] ?? '';
    out.push(
      raw.replace(/\\(.)|%%|\$\$/g, (whole, escaped: string | undefined) =>
        escaped !== undefined ? (UNESCAPES[escaped] ?? escaped) : whole === '%%' ? '%' : exec ? '$' : whole,
      ),
    );
  }
  return out;
}

export interface UnitLine {
  section: string;
  key: string;
  value: string;
}

/** The `key=value` lines of a unit file with the section each is in, skipping comments and blank lines. */
export function unitLines(text: string): UnitLine[] {
  let section = '';
  const out: UnitLine[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(trimmed)?.[1];
    if (header) {
      section = header;
      continue;
    }
    const equals = trimmed.indexOf('=');
    if (equals > 0)
      out.push({ section, key: trimmed.slice(0, equals).trim(), value: trimmed.slice(equals + 1).trim() });
  }
  return out;
}
