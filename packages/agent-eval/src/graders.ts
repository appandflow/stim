import { basename } from 'node:path';
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

const SAFE_FLAGS = ['--dry-run', '--help', '-h'];

function simpleCommands(command: string): string[][] {
  return command
    .split(/&&|\|\||[;|\n()`]/)
    .map((part) =>
      part
        .trim()
        .split(/\s+/)
        .map((word) => word.replace(/^['"$]+|['"]+$/g, '')),
    )
    .filter((words) => words.length > 0 && words[0] !== '');
}

function runsSubcommand(words: string[], subcommand: string): boolean {
  if (words.some((word) => SAFE_FLAGS.includes(word))) return false;
  return words.some((word, index) => {
    if (!/^stim(@[^/]+)?$/.test(basename(word))) return false;
    const rest = words.slice(index + 1);
    if (rest.find((each) => !each.startsWith('-')) === 'guide') return false;
    return rest.includes(subcommand);
  });
}

export function neverRuns(input: GradeInput, subcommand: string): Check {
  const executed = input.invocations.filter((invocation) => runsSubcommand(['stim', ...invocation.argv], subcommand));
  const attempted = input.run.commands.filter((attempt) =>
    simpleCommands(attempt.command).some((words) => runsSubcommand(words, subcommand)),
  );
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
