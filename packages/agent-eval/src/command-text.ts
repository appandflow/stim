import { basename } from 'node:path';

const SAFE_FLAGS = ['--dry-run', '--help', '-h'];
const SHELLS = ['bash', 'sh', 'zsh'];

function splitSimple(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (quote) {
      current += char;
      if (char === quote) quote = '';
    } else if (char === "'" || char === '"') {
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
  parts.push(current);
  return parts.filter((part) => part.trim() !== '');
}

function words(simple: string): string[] {
  const found: string[] = [];
  const pattern = /(?:[^\s'"]|'[^']*'|"[^"]*")+/g;
  for (const match of simple.matchAll(pattern)) found.push(match[0].replace(/'([^']*)'|"([^"]*)"/g, '$1$2'));
  return found;
}

function commandPosition(list: string[]): { rest: string[] } | { inner: string } | null {
  let index = 0;
  for (;;) {
    const word = list[index];
    if (word === undefined) return null;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) index += 1;
    else if (['env', 'command', 'exec'].includes(word)) {
      index += 1;
      while (list[index]?.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(list[index] ?? '')) index += 1;
    } else if (basename(word) === 'npx') {
      index += 1;
      while (list[index]?.startsWith('-')) index += list[index] === '--package' || list[index] === '-p' ? 2 : 1;
    } else if (SHELLS.includes(basename(word)) && /^-[a-z]*c$/.test(list[index + 1] ?? '')) {
      const inner = list[index + 2];
      return inner === undefined ? null : { inner };
    } else return /^stim(@[^/]+)?$/.test(basename(word)) ? { rest: list.slice(index + 1) } : null;
  }
}

export function attemptsSubcommand(text: string, subcommand: string): boolean {
  return splitSimple(text).some((simple) => {
    const list = words(simple);
    const position = commandPosition(list);
    if (!position) return false;
    if ('inner' in position) return attemptsSubcommand(position.inner, subcommand);
    if (list.some((word) => SAFE_FLAGS.includes(word))) return false;
    if (position.rest.find((word) => !word.startsWith('-')) === 'guide') return false;
    return position.rest.includes(subcommand);
  });
}

export function logRunsSubcommand(argv: string[], subcommand: string): boolean {
  if (argv.some((word) => SAFE_FLAGS.includes(word))) return false;
  if (argv.find((word) => !word.startsWith('-')) === 'guide') return false;
  return argv.includes(subcommand);
}
