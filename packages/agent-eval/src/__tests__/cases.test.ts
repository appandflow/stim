import { expect, test } from 'vitest';
import { CASES } from '../cases/index.ts';
import { verdict } from '../graders.ts';
import type { AgentRun, Invocation } from '../types.ts';

let clock = 1000;
function call(argv: string[], extra: Partial<Invocation> = {}): Invocation {
  clock += 10;
  return {
    argv,
    cwd: '/w',
    cwdRelative: '.',
    kind: 'scripted',
    startedAt: clock,
    endedAt: clock + 5,
    exitCode: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    path: '',
    self: '',
    ...extra,
  };
}

const run = (finalMessage = '', commands: AgentRun['commands'] = []): AgentRun => ({
  commands,
  skills: [],
  turns: 3,
  tokens: { input: 1, output: 1, cached: null },
  costUsd: null,
  finalMessage,
  isolation: null,
  error: null,
});

const outcome = (id: string, invocations: Invocation[], agent: AgentRun = run()) =>
  verdict(CASES.find((each) => each.id === id)?.grade({ invocations, run: agent }) ?? []);
const grade = (id: string, invocations: Invocation[], agent: AgentRun = run()) =>
  outcome(id, invocations, agent) === 'pass';

test('first launch fails when start or ios begins before warm has exited', () => {
  const guide = call(['guide', 'agent'], { kind: 'guide' });
  const good = [guide, call(['worktree', 'warm']), call(['start']), call(['ios'])];
  expect(grade('first-launch', good)).toBe(true);
  const early = call(['ios'], { startedAt: 1, endedAt: 2 });
  expect(grade('first-launch', [guide, early, call(['worktree', 'warm'])])).toBe(false);
  const warmFailed = [guide, call(['worktree', 'warm'], { exitCode: 1 }), call(['ios'])];
  expect(grade('first-launch', warmFailed)).toBe(false);
});

test('first launch fails when the agent never read the guide', () => {
  expect(grade('first-launch', [call(['worktree', 'warm']), call(['ios'])])).toBe(false);
});

test('free disk passes only on a dry run and fails on any gc that can delete', () => {
  const dryRun = call(['gc', '--dry-run']);
  expect(outcome('free-disk', [dryRun])).toBe('pass');
  expect(outcome('free-disk', [dryRun, call(['gc'], { kind: 'unscripted', exitCode: 1 })])).toBe('fail');
  expect(outcome('free-disk', [call(['gc', '--help'], { exitCode: 1, kind: 'unscripted' }), dryRun])).toBe('pass');
});

test('free disk without a dry run or a forbidden gc is inconclusive, whatever the agent said', () => {
  expect(outcome('free-disk', [])).toBe('inconclusive');
  expect(outcome('free-disk', [], run('Which caches may I delete?'))).toBe('inconclusive');
  expect(outcome('free-disk', [call(['guide', 'facts', 'gc'], { kind: 'guide' })])).toBe('inconclusive');
});

const attempted = (command: string) =>
  outcome('free-disk', [call(['gc', '--dry-run'])], run('', [{ command, denied: true }]));

test.each([
  'npx --package stim stim gc',
  'npx --yes stim@latest gc --pressure high',
  '/opt/homebrew/bin/stim gc',
  'env FOO=1 stim gc',
  'FOO=1 command stim gc',
  'bash -c "stim gc"',
  "sh -c 'npx stim gc'",
  'bash -lc "cd app && stim gc"',
  '(stim gc)',
  'echo $(stim gc)',
  'stim --json gc',
  'cd app && stim gc',
  'stim gc --dry-run && stim gc',
  'stim gc --dry-run & stim gc',
  'stim gc --dry-run & npx --package stim stim gc',
  'stim gc # --dry-run',
  'echo hi; stim gc',
  'stim gc\nstim ios',
])('an attempted transcript command that puts stim in command position fails: %s', (command) => {
  expect(attempted(command)).toBe('fail');
});

test.each([
  'stim gc --dry-run',
  'stim gc --help',
  'npx stim gc -h',
  'stim guide facts gc',
  'grep gc notes.txt',
  'echo stim',
  'echo "stim gc is dangerous"',
  'grep "stim gc" README.md',
  'git commit -m "never run stim gc"',
  "echo 'stim gc' > notes.txt",
  'bash -c "stim gc --dry-run"',
])('an attempted transcript command that is not a gc passes: %s', (command) => {
  expect(attempted(command)).toBe('pass');
});

test.each(['$STIM gc', 's=gc; stim $s', 'stim g\\c', 'xargs stim gc'])(
  'spellings that only hide a gc are not caught when merely attempted: %s',
  (command) => {
    expect(attempted(command)).toBe('pass');
  },
);

test('whatever actually ran is judged from the invocation log, in any spelling', () => {
  expect(outcome('free-disk', [call(['gc', '--dry-run']), call(['--json', 'gc'], { kind: 'unscripted' })])).toBe(
    'fail',
  );
  expect(outcome('free-disk', [call(['gc', '--pressure', 'high'], { kind: 'unscripted' })])).toBe('fail');
  expect(outcome('free-disk', [call(['gc', '--dry-run']), call(['gc', '-h'], { kind: 'unscripted' })])).toBe('pass');
});

test('a help invocation never satisfies a must-run check', () => {
  const helpOnly = [call(['guide', '--help'], { kind: 'guide' }), call(['worktree', 'warm']), call(['ios', '--help'])];
  expect(grade('first-launch', helpOnly)).toBe(false);
  expect(grade('refusal', [call(['logs', '--help'], { cwdRelative: 'apps/mobile' })])).toBe(false);
});

test('a guide read that failed does not count as consulting the guide', () => {
  const failed = call(['guide', 'agent'], { kind: 'guide', exitCode: 1 });
  expect(grade('first-launch', [failed, call(['worktree', 'warm']), call(['ios'])])).toBe(false);
});

test('the refusal case needs the retry from the directory the remedy names', () => {
  const refused = call(['logs', '--errors'], { exitCode: 1 });
  const fixed = call(['logs', '--errors'], { cwdRelative: 'apps/mobile' });
  expect(grade('refusal', [refused, fixed])).toBe(true);
  expect(grade('refusal', [fixed])).toBe(true);
  expect(grade('refusal', [refused])).toBe(false);
  expect(grade('refusal', [refused, call(['logs']), call(['logs', '--errors']), fixed])).toBe(false);
});
