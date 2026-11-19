import { basename } from 'node:path';

const SAFE_FLAGS = ['--dry-run', '--help', '-h'];
const SHELLS = ['bash', 'sh', 'zsh'];
const KEYWORDS = ['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{'];
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function withoutHeredocs(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let delimiter: string | null = null;
  for (const line of lines) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    kept.push(line);
    delimiter = /<<-?\s*['"]?(\w+)['"]?/.exec(line)?.[1] ?? null;
  }
  return kept.join('\n');
}

function splitSimple(text: string, quotes: boolean): string[] {
  const parts: string[] = [];
  let current = '';
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (quote) {
      current += char;
      if (char === quote) quote = '';
    } else if (quotes && (char === "'" || char === '"')) {
      quote = char;
      current += char;
    } else if (char === '#' && (current === '' || /\s$/.test(current))) {
      while (index < text.length && text[index] !== '\n') index += 1;
      parts.push(current);
      current = '';
    } else if (';&|\n()`'.includes(char)) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  if (quote) return splitSimple(text, false);
  parts.push(current);
  return parts.filter((part) => part.trim() !== '');
}

function words(simple: string): string[] {
  const found: string[] = [];
  for (const match of simple.matchAll(/(?:[^\s'"]|'[^']*'|"[^"]*")+/g))
    found.push(match[0].replace(/'([^']*)'|"([^"]*)"/g, '$1$2'));
  return found;
}

const VALUE_OPTIONS: Record<string, string[]> = {
  env: ['-u', '--unset'],
  sudo: ['-u', '-g', '-h'],
  nice: ['-n'],
  npx: ['--package', '-p'],
  pnpm: ['--package', '-p', '--filter', '-C', '--dir'],
};

function skipOptions(list: string[], from: number, name: string): number {
  const options = VALUE_OPTIONS[name] ?? [];
  const assignments = name === 'env';
  let index = from;
  for (let word = list[index]; word !== undefined; word = list[index]) {
    if (!word.startsWith('-') && !(assignments && ASSIGNMENT.test(word))) break;
    index += options.includes(word) ? 2 : 1;
  }
  return index;
}

function commandPosition(list: string[]): { program: string; rest: string[] } | { inner: string } | null {
  let index = 0;
  for (;;) {
    const word = list[index];
    if (word === undefined) return null;
    const name = basename(word);
    if (ASSIGNMENT.test(word) || KEYWORDS.includes(word)) index += 1;
    else if (['command', 'exec', 'time', 'nohup'].includes(name)) index = skipOptions(list, index + 1, name);
    else if (['env', 'sudo', 'nice', 'npx'].includes(name)) index = skipOptions(list, index + 1, name);
    else if (name === 'timeout') index = skipOptions(list, index + 1, name) + 1;
    else if (name === 'pnpm' && ['exec', 'dlx'].includes(list[index + 1] ?? ''))
      index = skipOptions(list, index + 2, 'pnpm');
    else if (name === 'eval') return { inner: list.slice(index + 1).join(' ') };
    else if (SHELLS.includes(name) && /^-[a-z]*c$/.test(list[index + 1] ?? '')) {
      const inner = list[index + 2];
      return inner === undefined ? null : { inner };
    } else if (SHELLS.includes(name) && list[index + 1] === '<<<') {
      const inner = list[index + 2];
      return inner === undefined ? null : { inner };
    } else return { program: name.replace(/@[^/]*$/, ''), rest: list.slice(index + 1) };
  }
}

export function logRunsSubcommand(argv: string[], subcommand: string): boolean {
  if (argv.some((word) => SAFE_FLAGS.includes(word))) return false;
  return argv.find((word) => !word.startsWith('-')) === subcommand;
}

export function attemptsCommand(text: string, test: (program: string, rest: string[]) => boolean): boolean {
  return splitSimple(withoutHeredocs(text), true).some((simple) => {
    const position = commandPosition(words(simple));
    if (!position) return false;
    if ('inner' in position) return attemptsCommand(position.inner, test);
    return test(position.program, position.rest);
  });
}

export function attemptsSubcommand(text: string, subcommand: string): boolean {
  return attemptsCommand(
    text,
    (program, rest) =>
      program === 'stim' && !rest.some((word) => SAFE_FLAGS.includes(word)) && logRunsSubcommand(rest, subcommand),
  );
}
