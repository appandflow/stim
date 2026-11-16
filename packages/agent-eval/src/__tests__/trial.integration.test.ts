import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CASES } from '../cases/index.ts';
import { claudeDriver } from '../drivers/claude.ts';
import { runTrial, type Arm } from '../trial.ts';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'agent-eval-test-'));
  process.env.AGENT_EVAL_TEST_SECRET = 'leaked';
});
afterEach(() => {
  delete process.env.AGENT_EVAL_TEST_SECRET;
  rmSync(directory, { recursive: true, force: true });
});

const withSkill: Arm = { name: 'with skill', skill: true, blank: [] };
const firstLaunch = CASES.find((each) => each.id === 'first-launch');
if (!firstLaunch) throw new Error('first-launch case is missing');

function fakeAgent(body: string): string {
  const file = join(directory, 'fake-claude');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe.skipIf(process.platform === 'win32')('trial', () => {
  test('a trial answers guides from the real renderer, scripts the rest, and hides the real environment from the agent', async () => {
    const bin = fakeAgent(`
stim guide agent > guide.txt
stim worktree warm
npx stim start
stim ios
stim doctor
printf '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"stim=%s secret=[%s] skill=%s git=%s","usage":{}}\\n' "$(command -v stim)" "$AGENT_EVAL_TEST_SECRET" "$(test -f .claude/skills/stim/SKILL.md && echo yes)" "$(git rev-parse --git-dir | grep -c worktrees)"
`);
    const outcome = await runTrial(firstLaunch, withSkill, claudeDriver, { model: null, bin, timeoutMs: 60_000 });
    expect(outcome.problems).toEqual([]);
    expect(outcome.invocations.map((each) => [each.kind, each.argv.join(' ')])).toEqual([
      ['guide', 'guide agent'],
      ['scripted', 'worktree warm'],
      ['scripted', 'start'],
      ['scripted', 'ios'],
      ['scripted', 'doctor'],
    ]);
    const guide = outcome.invocations[0];
    expect(guide?.stdoutBytes).toBeGreaterThan(1000);
    expect(outcome.run.finalMessage).toMatch(/^stim=\/.*\/bin\/stim secret=\[\] skill=yes git=1$/);
  }, 30_000);

  test('the without arms drop the skill and blank a guide command', async () => {
    const bin = fakeAgent(`
stim guide agent > guide.txt
printf '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"skill=[%s]","usage":{}}\\n' "$(test -f .claude/skills/stim/SKILL.md && echo yes)"
`);
    const arm: Arm = { name: 'without', skill: false, blank: [['guide', 'agent']] };
    const outcome = await runTrial(firstLaunch, arm, claudeDriver, { model: null, bin, timeoutMs: 60_000 });
    expect(outcome.run.finalMessage).toBe('skill=[]');
    expect(outcome.invocations.map((each) => [each.kind, each.stdoutBytes])).toEqual([['blanked', 0]]);
  }, 30_000);

  test('a trial is invalid when anything lands in the agent Stim home', async () => {
    const bin = fakeAgent(`
touch "$STIM_HOME/update-check.json"
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"","usage":{}}'
`);
    const outcome = await runTrial(firstLaunch, withSkill, claudeDriver, { model: null, bin, timeoutMs: 60_000 });
    expect(outcome.problems).toEqual(['the real stim ran: the agent Stim home is not empty']);
  }, 30_000);

  test('a hung agent is killed with its children when the timeout passes', async () => {
    const bin = fakeAgent('sleep 30 &\nsleep 30');
    const started = Date.now();
    const outcome = await runTrial(firstLaunch, withSkill, claudeDriver, { model: null, bin, timeoutMs: 700 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome.problems).toContain('the agent exceeded 700 ms and was killed');
  }, 30_000);
});
