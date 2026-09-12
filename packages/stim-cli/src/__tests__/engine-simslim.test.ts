import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeChildProcess, makeError } from './_factories.ts';
import { getExecutor, resetExecutor } from '../exec.ts';
import { processGroupAlive, readClaimSet } from '../ownership-claim.ts';
import {
  captureProcessIdentity,
  inspectProcessIdentity,
  waitForProcessExit,
  type ProcessRecord,
} from '../process-identity.ts';
import { reconcileSimSlim } from '../engine/simslim.ts';
import { waitForChild } from '../process-output.ts';

let root: string;
beforeEach(() => {
  resetExecutor();
  root = mkdtempSync(join(tmpdir(), 'stim-simslim-test-'));
  process.env.STIM_HOME = root;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function exitingChild({ stdout = [], stderr = [], code = 0 }: { stdout?: string[]; stderr?: string[]; code?: number }) {
  const child = makeChildProcess();
  queueMicrotask(() => {
    for (const line of stdout) child.stdout?.emit('data', `${line}\n`);
    for (const line of stderr) child.stderr?.emit('data', `${line}\n`);
    child.emit('exit', code, null);
  });
  return child;
}

test('does nothing when no profile is configured and Stim did not manage the simulator', async () => {
  let spawned = false;
  await expect(
    reconcileSimSlim({
      udid: 'U1',
      spawn: () => {
        spawned = true;
        return makeChildProcess();
      },
    }),
  ).resolves.toEqual({ managed: false, profile: null });
  expect(spawned).toBe(false);
});

test('applies a profile with the exact UDID and streams progress', async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const lines: string[] = [];
  const profile = '/repo/.simslim/dev.json';
  const signals = ['SIGINT', 'SIGTERM', 'exit'] as const;
  const listeners = signals.map((signal) => process.listeners(signal));
  const result = await reconcileSimSlim({
    udid: 'U1',
    profile,
    out: (line) => lines.push(line),
    spawn: (command, args) => {
      calls.push({ command, args });
      return exitingChild({
        stderr: ['Disabling 170 background services...', 'Rebooting the simulator...'],
        stdout: ['Done. Simulator reconfigured and rebooted slim.'],
      });
    },
  });

  expect(calls).toEqual([{ command: 'simslim', args: ['on', 'U1', '--profile', profile] }]);
  expect(lines).toHaveLength(3);
  expect(lines).toEqual(
    expect.arrayContaining([
      'SimSlim: Disabling 170 background services...',
      'SimSlim: Rebooting the simulator...',
      'SimSlim: Done. Simulator reconfigured and rebooted slim.',
    ]),
  );
  expect(result).toEqual({ managed: true, profile });
  expect(signals.map((signal) => process.listeners(signal))).toEqual(listeners);
});

test('restores stock services after the configured profile is removed', async () => {
  const calls: string[][] = [];
  const result = await reconcileSimSlim({
    udid: 'U1',
    previouslyManaged: true,
    spawn: (_command, args) => {
      calls.push([...args]);
      return exitingChild({ stdout: ['Done. All daemons re-enabled and simulator rebooted.'] });
    },
  });

  expect(calls).toEqual([['off', 'U1']]);
  expect(result).toEqual({ managed: false, profile: null });
});

test('reports the install command when the SimSlim executable is missing', async () => {
  const child = makeChildProcess();
  queueMicrotask(() => child.emit('error', makeError('spawn simslim ENOENT', { code: 'ENOENT' })));
  await expect(reconcileSimSlim({ udid: 'U1', profile: '/repo/dev.json', spawn: () => child })).rejects.toThrow(
    'brew install mobai-app/tap/simslim',
  );
});

test('includes recent SimSlim output when the command fails', async () => {
  await expect(
    reconcileSimSlim({
      udid: 'U1',
      profile: '/repo/dev.json',
      spawn: () => exitingChild({ stderr: ['iOS 17 does not persist launchd overrides'], code: 1 }),
    }),
  ).rejects.toThrow(/exit code 1.*iOS 17/);
});

test('a deadline kills the owned process group and releases its claim only after descendants exit', async () => {
  const exec = getExecutor();
  let pid: number | undefined;
  let descendant: number | undefined;
  const claimRoot = join(root, 'simslim-locks', 'u1.lock');
  try {
    await expect(
      reconcileSimSlim({
        udid: 'U1',
        profile: '/private/profile.json',
        timeoutMs: 700,
        cleanupMs: 2000,
        out: (line) => {
          const match = /descendant:(\d+)/.exec(line);
          if (match) descendant = Number(match[1]);
        },
        spawn: (_command, _args, options) => {
          const child = exec.spawn(
            process.execPath,
            [
              '-e',
              `
          const { spawn } = require('node:child_process');
          process.on('SIGTERM', () => {});
          const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'inherit' });
          console.log('descendant:' + child.pid);
          setInterval(() => {}, 1000);
        `,
            ],
            options,
          );
          pid = child.pid;
          return child;
        },
      }),
    ).rejects.toThrow(/process group has stopped/);
    expect(descendant).toBeGreaterThan(1);
    expect(pid && processGroupAlive(pid)).toBe(false);
    expect(readClaimSet(claimRoot).live).toEqual([]);
    expect(readClaimSet(claimRoot).unresolved).toEqual([]);
  } finally {
    if (pid && processGroupAlive(pid)) process.kill(-pid, 'SIGKILL');
  }
});

test('a surviving descendant retains the claim and refuses another reconciliation after its leader exits', async () => {
  const exec = getExecutor();
  let descendant: number | undefined;
  let identity: ProcessRecord | undefined;
  const claimRoot = join(root, 'simslim-locks', 'u1.lock');
  try {
    await expect(
      reconcileSimSlim({
        udid: 'U1',
        profile: '/private/profile.json',
        timeoutMs: 500,
        cleanupMs: 100,
        out: (line) => {
          const match = /descendant:(\d+)/.exec(line);
          if (match) {
            descendant = Number(match[1]);
            const captured = captureProcessIdentity(descendant);
            if (captured.ok) identity = { pid: descendant, processToken: captured.token };
          }
        },
        spawn: (_command, _args, options) =>
          exec.spawn(
            process.execPath,
            [
              '-e',
              `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
        console.log('descendant:' + child.pid);
        setTimeout(() => process.exit(0), 100);
      `,
            ],
            options,
          ),
      }),
    ).rejects.toThrow(/could not be confirmed stopped.*claim remains/);
    expect(inspectProcessIdentity(identity)).toBe('same');
    const survey = readClaimSet(claimRoot);
    expect(survey.live).toHaveLength(1);
    expect(survey.live[0]?.childDeclared).toBe(true);
    await expect(
      reconcileSimSlim({
        udid: 'U1',
        profile: '/private/profile.json',
        spawn: () => {
          throw new Error('must refuse before spawning');
        },
      }),
    ).rejects.toThrow(/another SimSlim operation/);
  } finally {
    if (descendant && inspectProcessIdentity(identity) === 'same') process.kill(descendant, 'SIGKILL');
    const exited = identity ? await waitForProcessExit(identity, 2000) : false;
    expect(exited).toBe(true);
  }
});

test.each(['SIGINT', 'SIGTERM', 'exit'] as const)(
  '%s stops the caller-owned SimSlim group without abandoning descendants',
  async (interruption) => {
    const marker = join(root, 'ready.json');
    const leaderRecord = join(root, 'leader.json');
    const driver = join(root, 'caller.mjs');
    const script = `
    import { writeFileSync } from 'node:fs';
    import { reconcileSimSlim } from ${JSON.stringify(new URL('../engine/simslim.ts', import.meta.url).href)};
    import { getExecutor } from ${JSON.stringify(new URL('../exec.ts', import.meta.url).href)};
    import { captureProcessIdentity } from ${JSON.stringify(new URL('../process-identity.ts', import.meta.url).href)};
    let leader;
    process.stdin.on('data', () => process.exit(23));
    await reconcileSimSlim({
      udid: 'U1', profile: '/private/profile.json', timeoutMs: 60000, cleanupMs: 1000,
      out(line) {
        const match = /descendant:([0-9]+)/.exec(line);
        if (match) writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ leader, descendant: Number(match[1]) }));
        console.error(line);
      },
      spawn(_command, _args, options) {
        const child = getExecutor().spawn(process.execPath, ['-e', ${JSON.stringify(`
          const { spawn } = require('node:child_process');
          process.on('SIGINT', () => {});
          process.on('SIGTERM', () => {});
          const child = spawn(process.execPath, ['-e', 'process.on("SIGINT", () => {}); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'inherit' });
          console.log('descendant:' + child.pid);
          setInterval(() => {}, 1000);
        `)}], options);
        leader = child.pid;
        const captured = captureProcessIdentity(leader);
        if (!captured.ok) {
          child.kill('SIGKILL');
          throw new Error('Fixture leader identity unavailable');
        }
        writeFileSync(${JSON.stringify(leaderRecord)}, JSON.stringify({ pid: leader, processToken: captured.token }));
        return child;
      },
    });
  `;
    writeFileSync(driver, script);
    const caller = getExecutor().spawn(process.execPath, ['--experimental-strip-types', driver], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = waitForChild(caller);
    const output: string[] = [];
    caller.stderr?.on('data', (chunk) => output.push(String(chunk)));
    caller.on('exit', (code, signal) => output.push(`Caller exited: ${code ?? signal}`));
    let fixture: { leader: number; descendant: number } | undefined;
    const identities: ProcessRecord[] = [];
    try {
      await vi.waitFor(
        () => {
          if (!existsSync(marker)) throw new Error(`Fixture has not started: ${output.join('')}`);
        },
        { timeout: 3000 },
      );
      fixture = JSON.parse(readFileSync(marker, 'utf8'));
      for (const pid of [fixture!.leader, fixture!.descendant]) {
        const captured = captureProcessIdentity(pid);
        expect(captured.ok).toBe(true);
        if (captured.ok) identities.push({ pid, processToken: captured.token });
      }
      if (interruption === 'exit') caller.stdin?.end('exit');
      else caller.kill(interruption);
      await vi.waitFor(() => expect(caller.exitCode).not.toBe(null), { timeout: 3000 });
      expect((await exited).code).toBe(interruption === 'exit' ? 23 : interruption === 'SIGINT' ? 130 : 143);
      await vi.waitFor(() => expect(processGroupAlive(fixture!.leader)).toBe(false), { timeout: 2000 });
      for (const identity of identities) expect(inspectProcessIdentity(identity)).toBe('gone');
      const survey = readClaimSet(join(root, 'simslim-locks', 'u1.lock'));
      expect(survey.live).toEqual([]);
      expect(survey.unresolved).toEqual([]);
      expect(survey.dead).toHaveLength(interruption === 'exit' ? 1 : 0);
      expect(output.join('')).toMatch(
        interruption === 'exit' ? /Caller exited: 23/ : /interrupted by SIG(INT|TERM).*process group has stopped/,
      );
    } finally {
      if (existsSync(leaderRecord)) {
        const identity: ProcessRecord = JSON.parse(readFileSync(leaderRecord, 'utf8'));
        if (inspectProcessIdentity(identity) === 'same') process.kill(-(identity.pid as number), 'SIGKILL');
      }
      caller.kill('SIGKILL');
      for (const identity of identities) {
        if (inspectProcessIdentity(identity) === 'same') process.kill(identity.pid as number, 'SIGKILL');
      }
      await exited;
    }
  },
  10000,
);
