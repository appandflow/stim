import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { runStop, stopWorkspaceNow } from '../commands/stop.ts';
import { nativeRunWaitNotice, runCancellation, withNativeBuildRun } from '../engine/native-run.ts';
import { spawnDeclared } from '../engine/spawn-claims.ts';
import { testContext } from './_context.ts';
import { getExecutor } from '../exec.ts';
import { type ClaimHolder } from '../ownership-claim.ts';
import { upsertProject } from '../workspace/config.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';

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
    const admission = new URL('../engine/device-capacity.ts', import.meta.url).href;
    const cliOperation = new URL('../cli-operation.ts', import.meta.url).href;
    const operationStateUrl = new URL('../engine/operation-state.ts', import.meta.url).href;
    writeFileSync(
      script,
      [
        `const { cancelledFailure, runCancellation, runCancellationSignal, withNativeBuildRun } = await import(${JSON.stringify(nativeRun)});`,
        `const { spawnDeclared } = await import(${JSON.stringify(spawnClaims)});`,
        `const { getExecutor } = await import(${JSON.stringify(exec)});`,
        `const { withDeviceBootAdmission } = await import(${JSON.stringify(admission)});`,
        `const { processContext, runProcessOperation } = await import(${JSON.stringify(cliOperation)});`,
        `const { operationState } = await import(${JSON.stringify(operationStateUrl)});`,
        'const { once } = await import("node:events");',
        'const [root, command, slot, tool] = process.argv.slice(2);',
        'const embedded = async (root, fn) => {',
        '  const controller = new AbortController();',
        '  const context = processContext(root, controller.signal);',
        '  operationState(context).abortOperation = (reason) => controller.abort(reason);',
        '  return { value: await fn(context) };',
        '};',
        'const operate = tool.startsWith("embedded") ? embedded : runProcessOperation;',
        'if (tool === "stubborn") process.on("SIGINT", () => {});',
        'const { value: result } = await operate(root, (context) => withNativeBuildRun(context, root, { command, platform: command, slot }, async () => {',
        '  console.log("holding");',
        '  if (tool === "queue") {',
        '    try {',
        '      await withDeviceBootAdmission({ platform: command, key: "new" }, async () => console.log("booted"), {',
        '        root, max: 1, signal: runCancellationSignal(context),',
        '        sources: { config: null, sims: [], booting: [{ platform: "ios", key: "other" }] },',
        '        waitingFor: (info) => { if (info) console.log("queued"); },',
        '      });',
        '    } catch (error) {',
        '      return cancelledFailure(context, command, { code: error.name });',
        '    }',
        '  }',
        '  if (tool === "tool" || tool === "stubborn-tool" || tool === "embedded") {',
        '    const body = tool !== "stubborn-tool" ? "setInterval(() => {}, 1000)" : "process.on(\'SIGINT\', () => {}); setInterval(() => {}, 1000)";',
        '    const child = spawnDeclared(context, () => getExecutor().spawn(process.execPath, ["-e", body], { stdio: "ignore" }));',
        '    console.log(`tool:${child.pid}`);',
        '    await once(child, "exit");',
        '    return runCancellation(context);',
        '  }',
        '  await new Promise((resolve) => setTimeout(resolve, 20_000));',
        '  return "finished";',
        '}, { write: (line) => console.error(line) }));',
        'console.log(JSON.stringify({ result }));',
      ].join('\n'),
    );
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    delete process.env.STIM_HOME;
    rmSync(dir, { recursive: true, force: true });
  });

  async function startHolder(
    command: string,
    slot: string,
    tool: 'tool' | 'stubborn-tool' | 'embedded' | 'embedded-sleep' | 'sleep' | 'stubborn' | 'queue',
  ) {
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
    const ready = tool === 'queue' ? 'queued' : tool.endsWith('tool') || tool === 'embedded' ? 'tool:' : 'holding';
    while (!out.includes(ready)) {
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

  test.skipIf(process.platform === 'win32')(
    'a build that ignores SIGINT is refused by name within the bounded wait',
    async () => {
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
    },
  );

  test.skipIf(process.platform === 'win32')(
    'aborting one of two operations in one process cancels only its own run and build tool',
    async () => {
      const operations = ['first', 'second'].map((name) => {
        const path = join(dir, name);
        mkdirSync(path);
        const controller = new AbortController();
        return { path, controller, context: testContext({ signal: controller.signal }) };
      });
      const tools = new Map<number, ChildProcess>();
      const runs = operations.map(({ path, context }, at) =>
        withNativeBuildRun(
          context,
          path,
          { command: 'ios', platform: 'ios' },
          async () => {
            const tool = spawnDeclared(context, () =>
              getExecutor().spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }),
            );
            tools.set(at, tool);
            await once(tool, 'exit');
            return runCancellation(context);
          },
          { write: () => {} },
        ),
      );
      await vi.waitFor(() => expect(tools.size).toBe(2));
      const [first, second] = operations;
      const [firstRun, secondRun] = runs;
      first?.controller.abort('SIGINT');
      expect(await firstRun).toBe('cancelled by an interrupt');
      expect(tools.get(1)?.exitCode).toBe(null);
      expect(runCancellation(second?.context)).toBe(null);
      tools.get(1)?.kill('SIGKILL');
      expect(await secondRun).toBe(null);
    },
  );

  test('stopping another slot leaves the build running and does not wait for its lock', async () => {
    const holder = await startHolder('ios', 'default', 'sleep');
    const lines: string[] = [];
    const calls: { slot?: string }[] = [];
    const result = await stopWorkspaceNow({
      root,
      slot: 'tablet',
      report: (line) => lines.push(line),
      deviceSlots: () => ['default', 'tablet'],
      recordedSlots: () => ['default', 'tablet'],
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

  test('an unknown slot is refused with the recorded slots before stop waits on the build', async () => {
    const holder = await startHolder('ios', 'default', 'sleep');
    upsertProject(root, { deviceSlots: { tablet: { ios: { deviceUdid: 'TABLET', owned: true } } } });
    writeWorkspaceState(root, { collectors: { 'android:fold': { pid: 1, processToken: 'fold' } } });
    let stops = 0;
    const result = await stopWorkspaceNow({
      root,
      slot: 'nonexistent',
      endRemote: () => null,
      stop: async () => {
        stops += 1;
        return stopped();
      },
    });
    expect(result).toMatchObject({
      refusal: {
        code: 'STIM_BAD_ARG',
        message: 'This workspace has no device slot named nonexistent. Its slots are default, fold, tablet.',
      },
    });
    expect(stops).toBe(0);
    expect(holder.child.exitCode).toBe(null);
  });

  test.skipIf(process.platform === 'win32')(
    'a slot no record names yet is known while its own first build holds the lock, and that build is interrupted',
    async () => {
      const holder = await startHolder('ios', 'phone', 'tool');
      const calls: { slot?: string }[] = [];
      const result = await stopWorkspaceNow({
        root,
        slot: 'phone',
        deviceSlots: () => [],
        stop: async (options) => {
          calls.push(options);
          return stopped();
        },
      });
      expect(result).toMatchObject({ ok: true });
      expect(calls).toEqual([{ root, slot: 'phone' }]);
      const [code] = await holder.exited;
      expect(code).toBe(0);
    },
  );
});
