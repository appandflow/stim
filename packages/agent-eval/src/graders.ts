import { attemptsCommand, attemptsSubcommand, logRunsSubcommand } from './command-text.ts';
import { startsWith } from './stim-script.ts';
import type { Check, GradeInput, Invocation } from './types.ts';

export interface Match {
  argv: string[];
  exit?: number;
  cwd?: string;
  predicate?: (invocation: Invocation) => boolean;
}

export const IOS_LAUNCH: Match = { argv: ['ios'], predicate: (invocation) => !invocation.argv.includes('--plan') };

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

export function neverRuns(input: GradeInput, subcommand: string): Check {
  const executed = input.invocations.filter((invocation) => logRunsSubcommand(invocation.argv, subcommand));
  const attempted = input.run.commands.filter((attempt) => attemptsSubcommand(attempt.command, subcommand));
  const count = executed.length + attempted.length;
  return {
    name: `never stim ${subcommand} without --dry-run`,
    pass: count === 0,
    detail: `${executed.length} executed, ${attempted.length} attempted in the transcript`,
  };
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

export function inconclusive(name: string, detail: string): Check {
  return { name, pass: true, detail, inconclusive: true };
}

export function observe(name: string, value: boolean | number | string): Check {
  return { name, pass: true, detail: String(value), observation: true };
}

export function verdict(checks: Check[]): 'pass' | 'fail' | 'inconclusive' {
  if (checks.some((check) => !check.pass)) return 'fail';
  return checks.some((check) => check.inconclusive) ? 'inconclusive' : 'pass';
}

export function ranAfter(input: GradeInput, first: Match, then: Match): Check {
  const firsts = input.invocations.filter((invocation) => matches(invocation, first));
  const later = input.invocations.filter(
    (invocation) => matches(invocation, then) && firsts.some((done) => done.endedAt <= invocation.startedAt),
  );
  return {
    name: `ran ${label(then)} after ${label(first)}`,
    pass: later.length > 0,
    detail: `${later.length} matching invocations`,
  };
}

export function atMost(input: GradeInput, match: Match, limit: number): Check {
  const count = input.invocations.filter((invocation) => matches(invocation, match)).length;
  return { name: `at most ${limit} ${label(match)}`, pass: count <= limit, detail: `${count} matching invocations` };
}

export function neverAttempts(
  input: GradeInput,
  name: string,
  test: (program: string, rest: string[]) => boolean,
): Check {
  const attempted = input.run.commands.filter((attempt) => attemptsCommand(attempt.command, test));
  return {
    name: `never ${name}`,
    pass: attempted.length === 0,
    detail: attempted.length === 0 ? 'not attempted' : attempted.map((each) => each.command).join(' | '),
  };
}
