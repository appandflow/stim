import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CASES } from '../cases/index.ts';
import { claudeDriver } from '../drivers/claude.ts';
import { runEvals } from '../run.ts';
import { checkGuide, runTrial, type Arm } from '../trial.ts';
import type { Roots } from '../types.ts';

let directory: string;
let roots: Roots;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'agent-eval-test-'));
  roots = {
    home: join(directory, 'home'),
    claudeProjects: join(directory, 'home', '.claude', 'projects'),
    claudeTmp: join(directory, 'claude-tmp'),
    codexHome: join(directory, 'home', '.codex'),
  };
  mkdirSync(roots.home);
  process.env.AGENT_EVAL_TEST_SECRET = 'leaked';
});
afterEach(() => {
  delete process.env.AGENT_EVAL_TEST_SECRET;
  rmSync(directory, { recursive: true, force: true });
});

const withSkill: Arm = { name: 'with skill', skill: true, blank: [] };
const firstLaunch = CASES.find((each) => each.id === 'first-launch');
if (!firstLaunch) throw new Error('first-launch case is missing');

const FIND_LOG = `log="$(grep -o '"log":"[^"]*"' "$(dirname "$(command -v stim)")/stim-eval.json" | cut -d'"' -f4)"`;

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
      confine: false,
      roots,
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

  test('the guide preflight passes on this checkout and refuses a guide CLI that fails', () => {
    expect(() => checkGuide()).not.toThrow();
    const broken = join(directory, 'broken-cli.mjs');
    writeFileSync(broken, "throw new Error('Cannot find module dist/state.mjs');\n");
    expect(() => checkGuide(broken)).toThrow(/stim guide agent fails in this checkout/);
  }, 60_000);

  test('the invocation log is not in the folder around the workspace', async () => {
    const bin = fakeAgent(`
stim guide agent > /dev/null
printf '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"%s","usage":{}}\\n' "$(ls -A .. | tr '\\n' ' ')"
`);
    const outcome = await runTrial(firstLaunch, withSkill, claudeDriver, options({ bin }));
    expect(outcome.invocations.map((each) => each.argv.join(' '))).toEqual(['guide agent']);
    expect(outcome.run.finalMessage).toContain('workspace');
    expect(outcome.run.finalMessage).not.toMatch(/harness|invocations/);
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
      confine: false,
      roots,
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
      confine: false,
      roots,
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
      confine: false,
      roots,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome.problems).toContain('the agent exceeded 700 ms and was killed');
  }, 30_000);

  const options = (extra = {}) => ({
    model: null,
    bin: null,
    timeoutMs: 60_000,
    confine: false,
    roots,
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
    expect(outcome.problems).toContain('the run was stopped and the agent was killed');
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
      expect(outcome.problems.join(' ')).toMatch(/left for the operator and not signalled: \d+ sleep 29/);
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
      confine: false,
      roots,
      model: null,
      bin: null,

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
    mkdirSync(join(directory, 'tmp'));
    const entry = fileURLToPath(new URL('./entry.ts', import.meta.url));
    const child = spawn(
      process.execPath,
      [entry, '--agent', 'claude', '--bin', bin, '--case', 'first-launch', '--trials', '1'],
      {
        stdio: 'ignore',
        env: {
          ...process.env,
          NODE_NO_WARNINGS: '1',
          TEST_ROOTS: JSON.stringify(roots),
          TMPDIR: join(directory, 'tmp'),
        },
      },
    );
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    await until(() => existsSync(marker) && readFileSync(marker, 'utf8').includes(' '));
    const [pid, workspace] = readFileSync(marker, 'utf8').trim().split(' ');
    child.kill('SIGINT');
    expect(await exited).toBe(130);
    expect(alive(Number(pid))).toBe(false);
    expect(existsSync(dirname(workspace ?? ''))).toBe(false);
    const results = join(roots.home, '.stim-agent-eval', 'results');
    const [run] = readdirSync(results);
    expect(existsSync(join(results, run ?? '', 'results.json'))).toBe(true);
  }, 60_000);

  test('the CLI --without guide:<words> arm blanks that guide command for the agent', () => {
    const bin = fakeAgent(`
stim guide errors > /dev/null
stim guide agent > /dev/null
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"","usage":{}}'
`);
    mkdirSync(join(directory, 'tmp'));
    const entry = fileURLToPath(new URL('./entry.ts', import.meta.url));
    const args = [
      '--agent',
      'claude',
      '--bin',
      bin,
      '--case',
      'first-launch',
      '--trials',
      '1',
      '--without',
      'guide:errors',
    ];
    const child = spawnSync(process.execPath, [entry, ...args], {
      stdio: 'ignore',
      timeout: 60_000,
      env: { ...process.env, NODE_NO_WARNINGS: '1', TEST_ROOTS: JSON.stringify(roots), TMPDIR: join(directory, 'tmp') },
    });
    expect(child.status).toBe(0);
    const results = join(roots.home, '.stim-agent-eval', 'results');
    const [run] = readdirSync(results);
    const log = join(results, run ?? '', 'claude', 'first-launch', 'without-guide-errors-1', 'invocations.jsonl');
    const kinds = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const each = JSON.parse(line) as { kind: string; argv: string[] };
        return [each.kind, each.argv.join(' ')];
      });
    expect(kinds).toEqual([
      ['blanked', 'guide errors'],
      ['guide', 'guide agent'],
    ]);
  }, 90_000);

  test('a trial is invalid, and the agent is stopped, when the home marker is readable from the scripted stim', async () => {
    const bin = fakeAgent('stim ios\nsleep 30');
    const started = Date.now();
    const outcome = await runTrial(firstLaunch, withSkill, claudeDriver, options({ bin, confine: true }));
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(outcome.problems.join(' ')).toMatch(/could read a marker file under the real home/);
  }, 40_000);

  test('a trial is invalid when the confinement probe never ran', async () => {
    const bin = fakeAgent(
      'echo \'{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"","usage":{}}\'',
    );
    const outcome = await runTrial(firstLaunch, withSkill, claudeDriver, options({ bin, confine: true }));
    expect(outcome.problems.join(' ')).toMatch(/confinement probe never ran/);
  }, 30_000);

  test('a signal that arrived before the agent could start means the agent never starts', async () => {
    const marker = join(directory, 'started.txt');
    const bin = fakeAgent(`echo started > "${marker}"`);
    const controller = new AbortController();
    controller.abort();
    const outcome = await runTrial(firstLaunch, withSkill, claudeDriver, options({ bin, signal: controller.signal }));
    expect(existsSync(marker)).toBe(false);
    expect(outcome.problems).toContain('the run was stopped and the agent was killed');
  }, 30_000);

  test('an abort asks the agent to stop with SIGTERM before anything is killed', async () => {
    const marker = join(directory, 'term.txt');
    const ready = join(directory, 'ready.txt');
    const bin = fakeAgent(
      `trap 'echo terminated > "${marker}"; exit 0' TERM\necho ready > "${ready}"\nsleep 30 &\nwait`,
    );
    const controller = new AbortController();
    const running = runTrial(firstLaunch, withSkill, claudeDriver, options({ bin, signal: controller.signal }));
    await until(() => existsSync(ready));
    controller.abort();
    await running;
    expect(readFileSync(marker, 'utf8').trim()).toBe('terminated');
  }, 30_000);

  test('a process in another session that works in the trial directory is reported by pid and not signalled', async () => {
    const marker = join(directory, 'detached.pid');
    const bin = fakeAgent(
      `perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' sleep 28 >/dev/null 2>&1 &\necho $! > "${marker}"\nsleep 1\necho '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"","usage":{}}'`,
    );
    const outcome = await runTrial(firstLaunch, withSkill, claudeDriver, options({ bin }));
    const pid = Number(readFileSync(marker, 'utf8'));
    try {
      expect(outcome.problems.join(' ')).toContain(`left for the operator and not signalled: ${pid} `);
      expect(alive(pid)).toBe(true);
    } finally {
      process.kill(pid, 'SIGKILL');
    }
  }, 60_000);

  test('the saved invocation log is redacted like the transcript', async () => {
    const bin = fakeAgent('stim sekrit-value-123');
    const driver = { ...claudeDriver, secrets: () => ['sekrit-value-123'] };
    const outcome = await runTrial(firstLaunch, withSkill, driver, options({ bin }));
    expect(outcome.invocations[0]?.argv).toEqual(['sekrit-value-123']);
    expect(outcome.invocationsText).not.toContain('sekrit-value-123');
    expect(outcome.invocationsText).toContain('[redacted]');
  }, 30_000);

  test('a malformed line in the agent-writable log invalidates the trial, stops the agent and does not crash the runner', async () => {
    const bin = fakeAgent(`${FIND_LOG}\nstim ios\necho "this is not json" >> "$log"\nsleep 30`);
    const started = Date.now();
    const outcome = await runTrial(firstLaunch, withSkill, claudeDriver, options({ bin }));
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(outcome.problems).toContain('the invocation log could not be read');
    expect(outcome.invocations).toEqual([]);
  }, 40_000);

  test('a transcript that names the harness log makes the trial invalid', async () => {
    const bin = fakeAgent(
      `echo '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"edited invocations.jsonl","usage":{}}'`,
    );
    const outcome = await runTrial(firstLaunch, withSkill, claudeDriver, options({ bin }));
    expect(outcome.problems.join(' ')).toMatch(/names the harness log file/);
  }, 30_000);

  test.each([
    [
      'a null argv word',
      '{"argv":[null],"cwd":"/w","cwdRelative":".","kind":"scripted","startedAt":1,"endedAt":2,"exitCode":0,"stdoutBytes":0,"stderrBytes":0,"path":"","self":""}',
    ],
    ['a missing field', '{"argv":["ios"]}'],
    [
      'a wrong kind',
      '{"argv":["ios"],"cwd":"/w","cwdRelative":".","kind":"x","startedAt":1,"endedAt":2,"exitCode":0,"stdoutBytes":0,"stderrBytes":0,"path":"","self":""}',
    ],
  ])(
    '%s in the log makes the trial invalid before any grader sees it',
    async (_, line) => {
      const bin = fakeAgent(`${FIND_LOG}\necho '${line}' >> "$log"\nstim ios\nsleep 30`);
      const outcome = await runTrial(firstLaunch, withSkill, claudeDriver, options({ bin }));
      expect(outcome.problems).toContain('the invocation log could not be read');
    },
    40_000,
  );

  test('a grader that throws is contained in its trial and the run continues', async () => {
    const bin = fakeAgent(
      `echo '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"","usage":{}}'`,
    );
    const throwing = {
      ...firstLaunch,
      grade: () => {
        throw new Error('grader bug');
      },
    };
    const outcome = await runEvals({
      cases: [throwing],
      drivers: [claudeDriver],
      arms: [withSkill],
      trials: 2,
      maxRuns: 5,
      timeoutMs: 20_000,
      model: null,
      bin,
      confine: false,
      roots,
      onProgress: () => undefined,
      onTrial: () => undefined,
    });
    expect(outcome.cells[0]?.trials.map((trial) => trial.invalid)).toEqual([
      ['the trial failed before it could be graded: grader bug'],
      ['the trial failed before it could be graded: grader bug'],
    ]);
  }, 60_000);

  test('a log line still being written is ignored until it ends and the trial stays healthy', async () => {
    const head = '{"argv":["ios"],"cwd":"/w","cwdRelative":".","kind":"scripted","startedAt":1,';
    const tail = '"endedAt":2,"exitCode":0,"stdoutBytes":0,"stderrBytes":0,"path":"","self":""}';
    const bin = fakeAgent(
      `${FIND_LOG}\nstim ios\nprintf '%s' '${head}' >> "$log"\nsleep 2\nprintf '%s\\n' '${tail}' >> "$log"\necho '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"","usage":{}}'`,
    );
    const outcome = await runTrial(firstLaunch, withSkill, claudeDriver, options({ bin }));
    expect(outcome.problems).toEqual([]);
    expect(outcome.invocations).toHaveLength(2);
  }, 40_000);

  test('a log that ends in a cut record after the agent has exited is the invalid result', async () => {
    const bin = fakeAgent(`${FIND_LOG}\nstim ios\nprintf '%s' '{"argv":["ios"' >> "$log"`);
    const outcome = await runTrial(firstLaunch, withSkill, claudeDriver, options({ bin }));
    expect(outcome.problems).toContain('the invocation log could not be read');
  }, 40_000);
});
