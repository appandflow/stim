import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { runStop, stopWorkspaceNow } from '../commands/stop.ts';
import { decideStopAction, nativeRunWaitNotice, type NativeRunHolder } from '../engine/native-run.ts';
import { getExecutor } from '../exec.ts';
import type { ClaimHolder } from '../ownership-claim.ts';

const ios = (slot = 'default'): NativeRunHolder => ({ command: 'ios', platform: 'ios', slot });

describe('decideStopAction', () => {
  test.each([
    ['a whole-workspace stop interrupts a live build', undefined, ios(), 'same', ['default'], 'interrupt'],
    [
      'stopping the slot the build targets interrupts it',
      'tablet',
      ios('tablet'),
      'same',
      ['default', 'tablet'],
      'interrupt',
    ],
    [
      'stopping the only device interrupts a build for a new slot',
      'default',
      ios('tablet'),
      'same',
      ['default'],
      'interrupt',
    ],
    [
      'stopping another slot leaves the build running',
      'tablet',
      ios('default'),
      'same',
      ['default', 'tablet'],
      'proceed',
    ],
    [
      'an Android build follows the same slot rule',
      'phone',
      { command: 'android', platform: 'android', slot: 'default' },
      'same',
      ['default', 'phone'],
      'proceed',
    ],
    [
      'a build whose owner is gone while its tool holds the claim is refused, not signalled',
      undefined,
      ios(),
      'gone',
      ['default'],
      'refuse',
    ],
    ['a build whose owner pid was reused is refused', 'default', ios(), 'different', ['default'], 'refuse'],
    [
      'another stop is waited on',
      undefined,
      { command: 'stop', platform: null, slot: 'default' },
      'same',
      ['default'],
      'wait',
    ],
    [
      'a claim with no recorded command is waited on',
      undefined,
      { command: null, platform: null, slot: 'default' },
      'same',
      ['default'],
      'wait',
    ],
  ] as const)('%s', (_name, stopSlot, holder, ownerIdentity, deviceSlots, action) => {
    expect(decideStopAction({ stopSlot, holder, ownerIdentity, deviceSlots }).action).toBe(action);
  });
});

test('a wait on the native-run lock is announced at once, per holder, and every 30 seconds', () => {
  let at = Date.parse('2026-09-25T12:12:00Z');
  const lines: string[] = [];
  const notice = nativeRunWaitNotice({ write: (line) => lines.push(line), now: () => at });
  const holder = (claimId: string, details: Record<string, unknown>) =>
    ({
      claimId,
      owner: { pid: 4242, processToken: 't' },
      startedAt: '2026-09-25T12:00:00Z',
      details,
    }) as unknown as ClaimHolder;
  const build = holder('a', { command: 'ios', platform: 'ios', slot: 'default' });
  notice(build);
  at += 29_000;
  notice(build);
  at += 1_000;
  notice(build);
  notice(holder('b', { command: 'android', platform: 'android', slot: 'tablet' }));
  notice(holder('c', {}));
  expect(lines).toEqual([
    'waiting for `stim ios` (pid 4242, running for 12m00s) in this workspace to finish',
    'still waiting for `stim ios` (pid 4242, running for 12m30s)',
    'waiting for `stim android --slot tablet` (pid 4242, running for 12m30s) in this workspace to finish',
    'waiting for another Stim run (pid 4242, running for 12m30s) in this workspace to finish',
  ]);
});

describe('stop against a real native-run holder', { timeout: 30_000 }, () => {
  let dir: string;
  let root: string;
  let script: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stim-native-run-'));
    process.env.STIM_HOME = join(dir, 'home');
    root = join(dir, 'app');
    mkdirSync(root);
    script = join(dir, 'holder.mjs');
    const nativeRun = new URL('../engine/native-run.ts', import.meta.url).href;
    const spawnClaims = new URL('../engine/spawn-claims.ts', import.meta.url).href;
    const exec = new URL('../exec.ts', import.meta.url).href;
    writeFileSync(
      script,
      [
        `const { runCancellation, withNativeBuildRun } = await import(${JSON.stringify(nativeRun)});`,
        `const { spawnDeclared } = await import(${JSON.stringify(spawnClaims)});`,
        `const { getExecutor } = await import(${JSON.stringify(exec)});`,
        'const { once } = await import("node:events");',
        'const [root, command, slot, tool] = process.argv.slice(2);',
        'if (tool === "stubborn") process.on("SIGINT", () => {});',
        'const result = await withNativeBuildRun(root, { command, platform: command, slot }, async () => {',
        '  console.log("holding");',
        '  if (tool === "tool") {',
        '    const child = spawnDeclared(() => getExecutor().spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }));',
        '    await once(child, "exit");',
        '    return runCancellation();',
        '  }',
        '  await new Promise((resolve) => setTimeout(resolve, 20_000));',
        '  return "finished";',
        '}, { write: (line) => console.error(line) });',
        'console.log(JSON.stringify({ result }));',
      ].join('\n'),
    );
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    delete process.env.STIM_HOME;
    rmSync(dir, { recursive: true, force: true });
  });

  async function startHolder(command: string, slot: string, tool: 'tool' | 'sleep' | 'stubborn') {
    const child = getExecutor().spawn(process.execPath, [script, root, command, slot, tool], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    children.push(child);
    const exited = once(child, 'exit');
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk) => (out += chunk));
    child.stderr?.on('data', (chunk) => (err += chunk));
    while (!out.includes('holding')) {
      if (child.exitCode !== null) throw new Error(`holder exited early: ${err}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { child, exited, output: () => ({ out, err }) };
  }

  const stopped = async () => ({
    ok: true,
    outcomes: { device: { ios: null, android: null } } as unknown as Awaited<ReturnType<typeof runStop>>['outcomes'],
    summary: 'stopped',
  });

  test('stop names the build, interrupts it, and the build cancels its tool and reports stop as the cause', async () => {
    const holder = await startHolder('ios', 'default', 'tool');
    const lines: string[] = [];
    const calls: { slot?: string }[] = [];
    const result = await stopWorkspaceNow({
      root,
      report: (line) => lines.push(line),
      endRemote: () => null,
      stop: async (options) => {
        calls.push(options);
        return stopped();
      },
    });
    expect(result).toMatchObject({ ok: true });
    expect(calls).toEqual([{ root, slot: undefined }]);
    expect(lines.join('\n')).toMatch(
      new RegExp(`interrupting \`stim ios\` \\(pid ${holder.child.pid}, running for \\d+s\\): sent SIGINT`),
    );
    const [code] = await holder.exited;
    expect(code).toBe(0);
    const { out, err } = holder.output();
    expect(JSON.parse(out.trim().split('\n').at(-1)!)).toEqual({
      result: `cancelled by \`stim stop\` (pid ${process.pid})`,
    });
    expect(err).toContain('stopping the running build tool');
  });

  test('a build that ignores SIGINT is refused by name within the bounded wait', async () => {
    const holder = await startHolder('android', 'default', 'stubborn');
    const lines: string[] = [];
    const result = await stopWorkspaceNow({
      root,
      interruptWaitMs: 300,
      report: (line) => lines.push(line),
      endRemote: () => null,
      stop: stopped,
    });
    expect(result).toMatchObject({ refusal: { code: 'STIM_STOP_BLOCKED' } });
    const { message, remedy } = (result as { refusal: { message: string; remedy: string } }).refusal;
    expect(message).toContain(`pid ${holder.child.pid}`);
    expect(message).toContain(join('native-run.lock', 'exclusive'));
    expect(remedy).toContain(`kill ${holder.child.pid}`);
    expect(holder.child.exitCode).toBe(null);
  });

  test('stopping another slot leaves the build running and does not wait for its lock', async () => {
    const holder = await startHolder('ios', 'default', 'sleep');
    const lines: string[] = [];
    const calls: { slot?: string }[] = [];
    const result = await stopWorkspaceNow({
      root,
      slot: 'tablet',
      report: (line) => lines.push(line),
      deviceSlots: () => ['default', 'tablet'],
      stop: async (options) => {
        calls.push(options);
        return stopped();
      },
    });
    expect(result).toMatchObject({ ok: true });
    expect(calls).toEqual([{ root, slot: 'tablet' }]);
    expect(lines.join('\n')).toContain(`leaving \`stim ios\` (pid ${holder.child.pid}`);
    expect(holder.child.exitCode).toBe(null);
  });

  test('a remote session is ended before stop waits on another stop', async () => {
    const holder = await startHolder('stop', 'default', 'sleep');
    const lines: string[] = [];
    let ended = 0;
    const waiting = stopWorkspaceNow({
      root,
      report: (line) => lines.push(line),
      endRemote: () => {
        ended += 1;
        return { status: 'torn-down', label: 'session-1' };
      },
      stop: stopped,
    });
    while (!lines.some((line) => line.includes('waiting for `stim stop`'))) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(ended).toBe(1);
    holder.child.kill('SIGKILL');
    const result = await waiting;
    expect(result).toMatchObject({ ok: true, outcomes: { device: { remote: { label: 'session-1' } } } });
  });
});
