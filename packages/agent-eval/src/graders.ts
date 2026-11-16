import { startsWith } from './stim-script.ts';
import type { Check, GradeInput, Invocation } from './types.ts';

export interface Match {
  argv: string[];
  exit?: number;
  cwd?: string;
  predicate?: (invocation: Invocation) => boolean;
}

export function matches(invocation: Invocation, match: Match): boolean {
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
  const count = hits.length + attempts.filter((attempt) => attempt.denied).length;
  return { name: `never ${name}`, pass: count === 0, detail: `${count} forbidden invocations or denied attempts` };
}

function attemptedArgv(command: string): string[][] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((part) => part.trim().split(/\s+/))
    .filter((words) => words[0] === 'stim')
    .map((words) => words.slice(1));
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

export function asksQuestion(input: GradeInput): boolean {
  return input.run.finalMessage.trim().includes('?') && !input.run.commands.some((attempt) => attempt.denied);
}

export function observe(name: string, value: boolean | number | string): Check {
  return { name, pass: true, detail: String(value), observation: true };
}

export function passed(checks: Check[]): boolean {
  return checks.every((check) => check.pass);
}
