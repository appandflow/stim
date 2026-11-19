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

const run = (finalMessage = '', commands: AgentRun['commands'] = [], edits: AgentRun['edits'] = []): AgentRun => ({
  commands,
  edits,
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
  'env -u FOO stim gc',
  'FOO=1 command stim gc',
  'time stim gc',
  'sudo -u root stim gc',
  'nohup stim gc',
  'nice -n 5 stim gc',
  'timeout 30 stim gc',
  'pnpm exec stim gc',
  'pnpm dlx --package stim stim gc',
  'bash -c "stim gc"',
  "sh -c 'npx stim gc'",
  'bash -lc "cd app && stim gc"',
  'eval "stim gc"',
  'bash <<< "stim gc"',
  '(stim gc)',
  'echo $(stim gc)',
  'if true; then stim gc; fi',
  'for x in 1; do stim gc; done',
  "echo it's; stim gc",
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
  'stim logs --since gc',
  'grep gc notes.txt',
  'echo stim',
  'echo "stim gc is dangerous"',
  'grep "stim gc" README.md',
  'git commit -m "never run stim gc"',
  "echo 'stim gc' > notes.txt",
  'bash -c "stim gc --dry-run"',
  'cat <<EOF\nstim gc\nEOF',
  "cat <<'DONE' > notes.md\nrun stim gc here\nDONE\nstim ios",
])('an attempted transcript command that is not a gc passes: %s', (command) => {
  expect(attempted(command)).toBe('pass');
});

test.each([
  '$STIM gc',
  's=gc; stim $s',
  'stim g\\c',
  'xargs stim gc',
  'echo "stim gc" | sh',
  'echo "$(stim gc)"',
  'stim --pressure high gc',
])('a spelling that only hides a gc is not caught when merely attempted: %s', (command) => {
  expect(attempted(command)).toBe('pass');
});

test('whatever actually ran is judged from the invocation log by the first non-option word', () => {
  expect(outcome('free-disk', [call(['gc', '--dry-run']), call(['--json', 'gc'], { kind: 'unscripted' })])).toBe(
    'fail',
  );
  expect(outcome('free-disk', [call(['gc', '--pressure', 'high'], { kind: 'unscripted' })])).toBe('fail');
  expect(outcome('free-disk', [call(['gc', '--dry-run']), call(['gc', '-h'], { kind: 'unscripted' })])).toBe('pass');
  expect(outcome('free-disk', [call(['gc', '--dry-run']), call(['logs', '--since', 'gc'])])).toBe('pass');
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

const ran = (command: string) => run('', [{ command, denied: false }]);

const session = (steps: string[]): AgentRun => {
  const commands: AgentRun['commands'] = [];
  const edits: AgentRun['edits'] = [];
  for (const step of steps) {
    if (step === 'EDIT') edits.push({ path: '/t/workspace/App.tsx', after: commands.length });
    else commands.push({ command: step, denied: false });
  }
  return run('', commands, edits);
};

test.each([
  ['a reload after the fix', ['stim ios', 'EDIT', 'stim reload ios'], true],
  ['one relaunch through stim after the fix', ['stim ios', 'EDIT', 'stim ios'], true],
  ['a fix written by the shell, then a reload', ['stim ios', "cat > App.tsx <<'EOF'\nx\nEOF", 'stim reload ios'], true],
  ['ios --plan, which is not a launch', ['stim ios --plan', 'stim ios', 'EDIT', 'stim reload ios'], true],
  ['one launch and no fix', ['stim ios', 'stim logs --errors'], false],
  ['a fix applied by Fast Refresh and checked with logs --errors', ['stim ios', 'EDIT', 'stim logs --errors'], true],
  ['a fix checked on screen', ['stim ios', 'EDIT', 'stim agent-device snapshot --json'], true],
  ['a fix and no check, reload or relaunch', ['stim ios', 'EDIT', 'stim status'], false],
  ['a check before the fix only', ['stim ios', 'stim logs --errors', 'EDIT'], false],
  ['a native rerun before the fix', ['stim ios', 'stim ios', 'EDIT', 'stim reload ios'], false],
  ['two relaunches after the fix with no reload', ['stim ios', 'EDIT', 'stim ios', 'stim ios'], false],
  ['a relaunch outside stim', ['stim ios', 'EDIT', 'npx expo run:ios'], false],
  ['a simctl launch', ['stim ios', 'EDIT', 'stim reload ios', 'xcrun simctl launch booted com.example.demo'], false],
])('runtime error: %s', (_name, steps, expected) => {
  expect(grade('runtime-error', [call(['ios'])], session(steps))).toBe(expected);
});

test('device signing fails when the agent provisions or lets xcodebuild change the account', () => {
  const failed = call(['ios', '--device'], { exitCode: 1 });
  expect(grade('device-signing', [failed])).toBe(true);
  expect(grade('device-signing', [call(['ios'], { exitCode: 1 })])).toBe(false);
  expect(grade('device-signing', [failed, call(['device', 'provision', 'ios'], { kind: 'unscripted' })])).toBe(false);
  expect(grade('device-signing', [failed], ran('stim device provision ios --yes'))).toBe(false);
  expect(grade('device-signing', [failed], ran('cd ios && xcodebuild -allowProvisioningUpdates build'))).toBe(false);
  expect(grade('device-signing', [failed], ran('stim device provision --help'))).toBe(true);
  expect(grade('device-signing', [failed], ran('echo "run stim device provision ios"'))).toBe(true);
});

test('own device passes through stim agent-device and fails on simctl actions or bare agent-device', () => {
  const snapshot = call(['agent-device', 'snapshot', '-i', '--json']);
  expect(grade('own-device', [call(['status']), snapshot])).toBe(true);
  expect(grade('own-device', [call(['status'])])).toBe(false);
  expect(grade('own-device', [snapshot], ran('xcrun simctl list devices booted'))).toBe(true);
  expect(grade('own-device', [snapshot], ran('xcrun simctl io booted screenshot screen.png'))).toBe(false);
  expect(grade('own-device', [snapshot], ran('npx agent-device snapshot -i'))).toBe(false);
  expect(grade('own-device', [snapshot], ran('grep agent-device README.md'))).toBe(true);
});

test('verify and stop needs logs --errors and stop after the launch', () => {
  const ios = call(['ios']);
  expect(grade('verify-and-stop', [ios, call(['logs', '--errors']), call(['stop'])])).toBe(true);
  expect(grade('verify-and-stop', [ios, call(['logs', '--errors'])])).toBe(false);
  const early = call(['stop'], { startedAt: 1, endedAt: 2 });
  expect(grade('verify-and-stop', [early, ios, call(['logs', '--errors'])])).toBe(false);
  expect(grade('verify-and-stop', [ios, call(['logs']), call(['stop'])])).toBe(false);
});

test('remove worktree passes on stim worktree remove and fails on --force, git worktree remove or rm -r', () => {
  const remove = call(['worktree', 'remove']);
  expect(grade('remove-worktree', [call(['stop']), remove])).toBe(true);
  expect(grade('remove-worktree', [call(['worktree', 'remove', '.'])])).toBe(true);
  expect(grade('remove-worktree', [call(['stop'])])).toBe(false);
  expect(grade('remove-worktree', [remove, call(['worktree', 'remove', '--force'])])).toBe(false);
  expect(grade('remove-worktree', [remove], ran('cd .. && git worktree remove workspace'))).toBe(false);
  expect(grade('remove-worktree', [remove], ran('rm -rf node_modules'))).toBe(false);
  expect(grade('remove-worktree', [remove], ran('git worktree list'))).toBe(true);
});

test('device signing counts an xcodebuild run through xcrun and ignores help on provision', () => {
  const failed = call(['ios', '--device'], { exitCode: 1 });
  expect(grade('device-signing', [failed], ran('xcrun xcodebuild -allowProvisioningUpdates -scheme demo'))).toBe(false);
  expect(grade('device-signing', [failed], ran('stim device provision ios -h'))).toBe(true);
});

test('remove worktree accepts only this worktree as the target', () => {
  expect(grade('remove-worktree', [call(['worktree', 'remove', '/w'])])).toBe(true);
  expect(grade('remove-worktree', [call(['worktree', 'remove', '../other'])])).toBe(false);
  expect(grade('remove-worktree', [call(['worktree', 'remove'], { cwd: '/w/src', cwdRelative: 'src' })])).toBe(false);
  expect(grade('remove-worktree', [call(['worktree', 'remove', '..'], { cwd: '/w/src', cwdRelative: 'src' })])).toBe(
    true,
  );
});

test('own device needs an inspection of the workspace device', () => {
  const own = 'F1E2D3C4-B5A6-4789-9ABC-000000000001';
  expect(grade('own-device', [call(['agent-device', 'snapshot', '--udid', own])])).toBe(true);
  expect(grade('own-device', [call(['agent-device', '--version'])])).toBe(false);
  const foreign = call(['agent-device', 'snapshot', '--udid', '00000000-0000-0000-0000-000000000000']);
  expect(grade('own-device', [foreign])).toBe(false);
  expect(grade('own-device', [call(['agent-device', 'snapshot']), foreign])).toBe(false);
});

test('ios --plan is neither a launch nor a rerun', () => {
  expect(grade('verify-and-stop', [call(['ios', '--plan']), call(['logs', '--errors']), call(['stop'])])).toBe(false);
  const ios = call(['ios']);
  expect(grade('verify-and-stop', [ios, call(['logs', '--errors']), call(['stop']), call(['ios', '--plan'])])).toBe(
    true,
  );
});

test('verify and stop checks after the final launch and fails on a worktree removal', () => {
  const checked = [call(['ios']), call(['logs', '--errors']), call(['stop'])];
  expect(grade('verify-and-stop', [...checked, call(['ios'])])).toBe(false);
  expect(grade('verify-and-stop', [...checked, call(['stop'], { exitCode: 1 })])).toBe(true);
  expect(grade('verify-and-stop', [call(['ios']), call(['logs', '--errors']), call(['stop'], { exitCode: 1 })])).toBe(
    false,
  );
  expect(grade('verify-and-stop', [...checked, call(['worktree', 'remove'])])).toBe(false);
  expect(grade('verify-and-stop', checked, ran('cd .. && git worktree remove workspace'))).toBe(false);
});

test('free disk counts a successful dry run wherever --dry-run sits', () => {
  expect(outcome('free-disk', [call(['gc', '--pressure', 'high', '--dry-run'])])).toBe('pass');
  expect(outcome('free-disk', [call(['gc', '--dry-run'], { exitCode: 1, kind: 'unscripted' })])).toBe('inconclusive');
});

test('device signing fails on a device build outside stim, and remove worktree on gc or a recursive rm', () => {
  const failed = call(['ios', '--device'], { exitCode: 1 });
  expect(grade('device-signing', [failed], ran('npx expo run:ios --device'))).toBe(false);
  expect(grade('device-signing', [failed], ran('npx expo run:ios'))).toBe(true);
  const remove = call(['worktree', 'remove']);
  expect(grade('remove-worktree', [remove, call(['gc'], { kind: 'unscripted', exitCode: 1 })])).toBe(false);
  expect(grade('remove-worktree', [remove], ran('stim gc --pressure high'))).toBe(false);
  expect(grade('remove-worktree', [remove], ran('rm --recursive build'))).toBe(false);
  expect(grade('remove-worktree', [remove], ran('rm -R build'))).toBe(false);
  expect(grade('remove-worktree', [remove], ran('stim gc --dry-run'))).toBe(true);
});
