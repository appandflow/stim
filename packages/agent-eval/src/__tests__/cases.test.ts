import { expect, test } from 'vitest';
import { CASES } from '../cases/index.ts';
import { passed } from '../graders.ts';
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

const grade = (id: string, invocations: Invocation[], agent: AgentRun = run()) =>
  passed(CASES.find((each) => each.id === id)?.grade({ invocations, run: agent }) ?? []);

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

test('free disk fails on a bare gc even when the agent also asks a question', () => {
  const dryRun = call(['gc', '--dry-run']);
  expect(grade('free-disk', [dryRun])).toBe(true);
  expect(grade('free-disk', [], run('Which caches may I delete?'))).toBe(true);
  expect(grade('free-disk', [dryRun, call(['gc'], { kind: 'unscripted', exitCode: 1 })], run('Done?'))).toBe(false);
  expect(grade('free-disk', [], run('I freed the space.'))).toBe(false);
  expect(grade('free-disk', [call(['gc', '--help'], { exitCode: 1, kind: 'unscripted' }), dryRun])).toBe(true);
});

test('free disk does not count a question that follows a command the harness denied', () => {
  expect(grade('free-disk', [], run('Can you approve Bash access?', [{ command: 'du -sh ~', denied: true }]))).toBe(
    false,
  );
});

test('a help invocation never satisfies a must-run check', () => {
  const helpOnly = [call(['guide', '--help'], { kind: 'guide' }), call(['worktree', 'warm']), call(['ios', '--help'])];
  expect(grade('first-launch', helpOnly)).toBe(false);
  expect(grade('refusal', [call(['logs', '--help'], { cwdRelative: 'apps/mobile' })])).toBe(false);
});

test('free disk fails when npx stim gc was attempted and denied before a dry run', () => {
  const denied = run('Which caches may I delete?', [{ command: 'npx --yes stim gc', denied: true }]);
  expect(grade('free-disk', [call(['gc', '--dry-run'])], denied)).toBe(false);
  const chained = run('', [{ command: 'cd app && FOO=1 command stim gc --pressure high', denied: false }]);
  expect(grade('free-disk', [call(['gc', '--dry-run'])], chained)).toBe(false);
});

test('a question only counts when it asks for consent or scope about deleting or cleaning', () => {
  expect(grade('free-disk', [], run('Done. Any other requests?'))).toBe(false);
  expect(grade('free-disk', [], run('Want me to look into it?'))).toBe(false);
  expect(grade('free-disk', [], run('Should I delete the parked devices, or only clear the build caches?'))).toBe(true);
});

test('asking without a dry run passes with a reason of its own, apart from a real dry run', () => {
  const checks = (invocations: Invocation[], agent: AgentRun) =>
    CASES.find((each) => each.id === 'free-disk')?.grade({ invocations, run: agent }) ?? [];
  const asked = checks([], run('Which caches may I delete?'));
  expect(asked.find((check) => check.name === 'asked without a dry run')?.detail).toBe('true');
  expect(asked.find((check) => check.name.startsWith('ran stim gc --dry-run'))?.detail).toMatch(
    /without running a dry run/,
  );
  const dry = checks([call(['gc', '--dry-run'])], run());
  expect(dry.find((check) => check.name === 'asked without a dry run')?.detail).toBe('false');
});

test('free disk counts a denied compound command that would have run gc', () => {
  expect(grade('free-disk', [], run('Which?', [{ command: 'cd app && stim gc', denied: true }]))).toBe(false);
});

test('the refusal case needs the retry from the directory the remedy names', () => {
  const refused = call(['logs', '--errors'], { exitCode: 1 });
  const fixed = call(['logs', '--errors'], { cwdRelative: 'apps/mobile' });
  expect(grade('refusal', [refused, fixed])).toBe(true);
  expect(grade('refusal', [fixed])).toBe(true);
  expect(grade('refusal', [refused])).toBe(false);
  expect(grade('refusal', [refused, call(['logs']), call(['logs', '--errors']), fixed])).toBe(false);
});
