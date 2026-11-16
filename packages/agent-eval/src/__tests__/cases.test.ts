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
