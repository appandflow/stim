import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CASES } from '../cases/index.ts';
import { claudeDriver } from '../drivers/claude.ts';
import { runEvals } from '../run.ts';
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
    const outcome = await runTrial(firstLaunch, withSkill, claudeDriver, {
      model: null,
      bin,
      timeoutMs: 60_000,
      quarantineDir: join(directory, 'q'),
    });
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
    const outcome = await runTrial(firstLaunch, arm, claudeDriver, {
      model: null,
      bin,
      timeoutMs: 60_000,
      quarantineDir: join(directory, 'q'),
    });
    expect(outcome.run.finalMessage).toBe('skill=[]');
    expect(outcome.invocations.map((each) => [each.kind, each.stdoutBytes])).toEqual([['blanked', 0]]);
  }, 30_000);

  test('a trial is invalid when anything lands in the agent Stim home', async () => {
    const bin = fakeAgent(`
touch "$STIM_HOME/update-check.json"
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"","usage":{}}'
`);
    const outcome = await runTrial(firstLaunch, withSkill, claudeDriver, {
      model: null,
      bin,
      timeoutMs: 60_000,
      quarantineDir: join(directory, 'q'),
    });
    expect(outcome.problems).toEqual(['the real stim ran: the agent Stim home is not empty']);
  }, 30_000);

  test('a hung agent is killed with its children when the timeout passes', async () => {
    const bin = fakeAgent('sleep 30 &\nsleep 30');
    const started = Date.now();
    const outcome = await runTrial(firstLaunch, withSkill, claudeDriver, {
      model: null,
      bin,
      timeoutMs: 700,
      quarantineDir: join(directory, 'q'),
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome.problems).toContain('the agent exceeded 700 ms and was killed');
  }, 30_000);

  const options = (extra = {}) => ({
    model: null,
    bin: null,
    timeoutMs: 60_000,
    quarantineDir: join(directory, 'q'),
    ...extra,
  });

  async function until(check: () => boolean): Promise<void> {
    for (let waited = 0; !check(); waited += 25) {
      if (waited > 20_000) throw new Error('the condition never held');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test('an abort stops the agent, runs cleanup and removes the trial directory', async () => {
    const marker = join(directory, 'agent.txt');
    const bin = fakeAgent(`echo "$$ $PWD" > "${marker}"\nsleep 30`);
    const controller = new AbortController();
    const running = runTrial(firstLaunch, withSkill, claudeDriver, options({ bin, signal: controller.signal }));
    await until(() => existsSync(marker) && readFileSync(marker, 'utf8').includes(' '));
    const [pid, workspace] = readFileSync(marker, 'utf8').trim().split(' ');
    controller.abort();
    const outcome = await running;
    expect(outcome.problems).toContain('the run was interrupted and the agent was killed');
    expect(alive(Number(pid))).toBe(false);
    expect(existsSync(dirname(workspace ?? ''))).toBe(false);
  }, 30_000);

  test('a descendant that outlives the agent is reported and is not signalled', async () => {
    const marker = join(directory, 'leftover.pid');
    const bin = fakeAgent(
      `sleep 29 >/dev/null 2>&1 &\necho $! > "${marker}"\necho '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"","usage":{}}'`,
    );
    const outcome = await runTrial(firstLaunch, withSkill, claudeDriver, options({ bin }));
    const pid = Number(readFileSync(marker, 'utf8'));
    try {
      expect(outcome.problems.join(' ')).toMatch(/1 processes remain in the agent's process group/);
      expect(alive(pid)).toBe(true);
    } finally {
      process.kill(pid, 'SIGKILL');
    }
  }, 30_000);

  test('an error in one trial is recorded and the next trial still runs', async () => {
    const broken = {
      ...claudeDriver,
      prepare: () => {
        throw new Error('no login');
      },
    };
    const outcome = await runEvals({
      cases: [firstLaunch],
      drivers: [broken],
      arms: [withSkill],
      trials: 2,
      maxRuns: 5,
      timeoutMs: 1000,
      model: null,
      bin: null,
      quarantineDir: join(directory, 'q'),
      onProgress: () => undefined,
      onTrial: () => undefined,
    });
    const [cell] = outcome.cells;
    expect(cell?.trials.map((trial) => trial.invalid)).toEqual([
      ['the trial failed before it could be graded: no login'],
      ['the trial failed before it could be graded: no login'],
    ]);
  }, 30_000);

  test('SIGINT to the CLI stops the live agent, cleans up, writes the results and exits 130', async () => {
    const marker = join(directory, 'cli-agent.txt');
    const bin = fakeAgent(`echo "$$ $PWD" > "${marker}"\nsleep 30`);
    const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));
    const out = join(directory, 'results');
    const child = spawn(
      process.execPath,
      [cli, '--agent', 'claude', '--bin', bin, '--case', 'first-launch', '--trials', '1', '--out', out],
      {
        stdio: 'ignore',
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      },
    );
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    await until(() => existsSync(marker) && readFileSync(marker, 'utf8').includes(' '));
    const [pid, workspace] = readFileSync(marker, 'utf8').trim().split(' ');
    child.kill('SIGINT');
    expect(await exited).toBe(130);
    expect(alive(Number(pid))).toBe(false);
    expect(existsSync(dirname(workspace ?? ''))).toBe(false);
    const [run] = readdirSync(out);
    expect(existsSync(join(out, run ?? '', 'results.json'))).toBe(true);
  }, 60_000);
});
