import { relative, sep } from 'node:path';
import type { ScriptRule } from './types.ts';

export function startsWith(argv: string[], prefix: string[]): boolean {
  return prefix.length <= argv.length && prefix.every((word, index) => argv[index] === word);
}

export function relativeCwd(workspace: string, cwd: string): string {
  return relative(workspace, cwd).split(sep).join('/') || '.';
}

export function matchRule(rules: ScriptRule[], argv: string[], cwdRelative: string): ScriptRule | null {
  for (const rule of rules) {
    if (rule.cwd !== undefined && rule.cwd !== cwdRelative) continue;
    const same = rule.prefix
      ? startsWith(argv, rule.argv)
      : argv.length === rule.argv.length && startsWith(argv, rule.argv);
    if (same) return rule;
  }
  return null;
}

export function isBlanked(blank: string[][], argv: string[]): boolean {
  return blank.some((prefix) => startsWith(argv, prefix));
}

export function unscriptedMessage(argv: string[]): string {
  return `stim: "stim ${argv.join(' ')}" is not available in this evaluation; only the commands the task needs are scripted.\n`;
}
