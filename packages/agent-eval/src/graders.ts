import { startsWith } from './stim-script.ts';
import type { Check, GradeInput, Invocation } from './types.ts';

export interface Match {
  argv: string[];
  exit?: number;
  cwd?: string;
  predicate?: (invocation: Invocation) => boolean;
}

function isHelp(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

export function matches(invocation: Invocation, match: Match): boolean {
  if (isHelp(invocation.argv)) return false;
  if (!startsWith(invocation.argv, match.argv)) return false;
  if (match.exit !== undefined && invocation.exitCode !== match.exit) return false;
  if (match.cwd !== undefined && invocation.cwdRelative !== match.cwd) return false;
  return match.predicate ? match.predicate(invocation) : true;
}

function label(match: Match): string {
  return `stim ${match.argv.join(' ')}`;
}

export function ran(input: GradeInput, match: Match): Check {
  const found = input.invocations.filter((invocation) => matches(invocation, match));
  return { name: `ran ${label(match)}`, pass: found.length > 0, detail: `${found.length} matching invocations` };
}

export function exitedBefore(input: GradeInput, first: Match, then: Match): Check {
  const firsts = input.invocations.filter((invocation) => matches(invocation, { ...first, exit: first.exit ?? 0 }));
  const thens = input.invocations.filter((invocation) => matches(invocation, then));
  const early = thens.filter((later) => !firsts.some((done) => done.endedAt <= later.startedAt));
  return {
    name: `${label(first)} exits before ${label(then)}`,
    pass: early.length === 0,
    detail:
      early.length === 0
        ? `${thens.length} later invocations`
        : `${early.length} started before ${label(first)} exited`,
  };
}

export function never(input: GradeInput, name: string, forbidden: (argv: string[]) => boolean): Check {
  const hits = input.invocations.filter((invocation) => forbidden(invocation.argv));
  const attempts = input.run.commands.filter((attempt) => attemptedArgv(attempt.command).some(forbidden));
  const count = Math.max(hits.length, attempts.length);
  return { name: `never ${name}`, pass: count === 0, detail: `${count} forbidden invocations or attempts` };
}

function attemptedArgv(command: string): string[][] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((part) =>
      part
        .trim()
        .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')
        .replace(/^(?:command|exec|time)\s+/, '')
        .split(/\s+/)
        .map((word) => word.replace(/^['"]|['"]$/g, '')),
    )
    .flatMap((words) => {
      if (words[0] === 'stim') return [words.slice(1)];
      if (words[0] !== 'npx') return [];
      const at = words.findIndex((word, index) => index > 0 && !word.startsWith('-'));
      return at > 0 && /^stim(@\S+)?$/.test(words[at] ?? '') ? [words.slice(at + 1)] : [];
    });
}

export function atMostUnscripted(input: GradeInput, limit: number): Check {
  const count = input.invocations.filter((invocation) => invocation.kind === 'unscripted').length;
  return { name: `at most ${limit} unscripted commands`, pass: count <= limit, detail: `${count} unscripted` };
}

export function guideBytes(invocations: Invocation[]): number {
  return invocations
    .filter((invocation) => invocation.kind === 'guide')
    .reduce((sum, each) => sum + each.stdoutBytes, 0);
}

const ACTION = /\b(delet\w*|remov\w*|clean\w*|clear\w*|free\w*|reclaim\w*|purg\w*|eras\w*|prun\w*|gc)\b/i;
const CONSENT =
  /\b(want|wants|should|shall|ok|okay|go ahead|proceed|confirm|approve|which|what|how much|all|only|may|can|could|would|permission)\b/i;

export function asksQuestion(input: GradeInput): boolean {
  if (input.run.commands.some((attempt) => attempt.denied)) return false;
  const sentences = input.run.finalMessage.match(/[^.!?\n]*\?/g) ?? [];
  return sentences.some((sentence) => ACTION.test(sentence) && CONSENT.test(sentence));
}

export function observe(name: string, value: boolean | number | string): Check {
  return { name, pass: true, detail: String(value), observation: true };
}

export function passed(checks: Check[]): boolean {
  return checks.every((check) => check.pass);
}
