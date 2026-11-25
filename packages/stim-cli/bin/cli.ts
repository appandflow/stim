#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { runId, trace } from '@stim-cli/core/state';
import { debugLog } from '../src/debug-log.ts';
import { CliExit } from '../src/cli-operation.ts';
import { CliUsageError, defineOp, runCli, type Op } from '../src/cli/define-op.ts';
import { refuseRelativeStimPaths } from '../src/workspace/config.ts';
import { hungRead } from '../src/workspace/bounded-read.ts';

if (process.argv[2] === '__stimd') {
  await (await import('../src/stimd/main.ts')).runStimdEntry(process.argv.slice(3));
  process.exit();
}

if (process.argv[2] === '__job') {
  const code = await (await import('../src/job/main.ts')).runJobEntry(process.argv.slice(3));
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
  process.exit(code);
}

const commands = new Map<string, () => Promise<{ default: Op }>>([
  ['doctor', () => import('../src/commands/doctor.ts')],
  ['worktree', () => import('../src/commands/worktree.ts')],
  ['start', () => import('../src/commands/start.ts')],
  ['ports', () => import('../src/commands/ports.ts')],
  ['services', () => import('../src/commands/services.ts')],
  ['stop', () => import('../src/commands/stop.ts')],
  ['ios', () => import('../src/commands/ios.ts')],
  ['android', () => import('../src/commands/android.ts')],
  ['web', () => import('../src/commands/web.ts')],
  ['macos', () => import('../src/commands/macos.ts')],
  ['reload', () => import('../src/commands/reload.ts')],
  ['revive', () => import('../src/commands/revive.ts')],
  ['agent-device', () => import('../src/commands/agent-device.ts')],
  ['ci', () => import('../src/commands/ci.ts')],
  ['serve', () => import('../src/commands/serve.ts')],
  ['pair', () => import('../src/commands/pair.ts')],
  ['pairings', () => import('../src/commands/pairings.ts')],
  ['service', () => import('../src/commands/service.ts')],
  ['setup', () => import('../src/commands/setup.ts')],
  ['share', () => import('../src/commands/share.ts')],
  ['device', () => import('../src/commands/device.ts')],
  ['logs', () => import('../src/commands/logs.ts')],
  ['remote', () => import('../src/commands/remote.ts')],
  ['settings', () => import('../src/commands/settings.ts')],
  ['status', () => import('../src/commands/status.ts')],
  ['test', () => import('../src/commands/test.ts')],
  ['stats', () => import('../src/commands/stats.ts')],
  ['gc', () => import('../src/commands/gc.ts')],
  ['guide', () => import('../src/commands/guide.ts')],
  ['engine', () => import('../src/commands/engine.ts')],
  ['plugin', () => import('../src/commands/plugin.ts')],
]);

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

function terminator(args: string[]): number {
  const index = args.indexOf('--');
  return index < 0 ? args.length : index;
}

export interface MainContext {
  /** The version of the copy the person ran, when a router runs this build in its place. */
  invokedVersion?: string;
  /** Called instead of throwing when this build's CLI code cannot load, so a router can run another copy. */
  onLoadError?: (error: unknown) => unknown;
}

/** Runs the CLI for `argv`, in `process.argv`'s shape. */
export async function main(argv: string[], ctx: MainContext = {}): Promise<void> {
  Reflect.set(globalThis, Symbol.for('stim.cli'), true);

  let end: (() => unknown) | undefined;
  let exitCode: number | undefined;
  const json =
    argv.slice(0, terminator(argv)).includes('--json') &&
    argv[2] !== 'logs' &&
    !(argv[2] === 'status' && argv.includes('--watch'));
  const originalWrite = process.stdout.write;
  let stdoutWritten = false;
  if (json) {
    process.stdout.write = function (chunk, ...args) {
      if ((typeof chunk === 'string' ? chunk.length : chunk.byteLength) > 0) stdoutWritten = true;
      return Reflect.apply(originalWrite, this, [chunk, ...args]);
    };
  }
  try {
    refuseRelativeStimPaths();
    process.env.STIM_RUN_ID = runId();
    const first = argv[2];
    const before = async (path: string[]) => {
      trace.command(`stim ${path.join(' ')}`, { version: pkg.version });
      if (debugLog.enabled()) {
        const started = Date.now();
        debugLog.log('run_start', {
          version: pkg.version,
          ...(ctx.invokedVersion ? { invokedVersion: ctx.invokedVersion } : {}),
          command: path,
          flags: argv
            .slice(2)
            .filter((arg) => arg.startsWith('-'))
            .map((arg) => arg.split('=')[0]),
        });
        process.on('exit', (code) => debugLog.log('run_end', { exit: code, ms: Date.now() - started }));
      }
      try {
        const { warnCriticalDisk } = await import('../src/stimd/passes/trigger.ts');
        warnCriticalDisk();
      } catch {}
      const { runOperation } = await import('../src/run-operation.ts');
      const entered = await runOperation({
        caller: 'cli',
        command: path.length === 1 ? (path[0] ?? '') : '',
        plan: argv.includes('--plan'),
        cwd: process.cwd(),
        env: process.env,
      });
      if ('refusal' in entered) {
        const { refusal } = entered;
        if (argv.slice(0, terminator(argv)).includes('--json')) console.log(JSON.stringify(refusal));
        console.error(`${refusal.code}: ${refusal.message}`);
        console.error(refusal.remedy);
        process.exit(1);
      }
      end = entered.end;
    };
    const loadCommand = commands.get((first === 'help' ? argv[3] : first) ?? '');
    const args = argv.slice(2);
    let code = 0;
    if (loadCommand) {
      const help = first === 'help';
      code = await runCli((await loadCommand()).default, help ? ['--help', ...argv.slice(4)] : argv.slice(3), {
        version: pkg.version,
        before,
        help,
      });
    } else if (args.slice(0, terminator(args)).some((arg) => arg === '--version' || arg === '-V')) {
      process.stdout.write(`${pkg.version}\n`);
    } else {
      const modules = await Promise.all([...commands.values()].map((load) => load()));
      const root = defineOp({
        name: 'stim',
        description: 'Run React Native, Expo and native apps for coding agents',
        version: true,
        commands: modules.map((module) => module.default),
      });
      code = await runCli(root, args, { version: pkg.version, before, root: true });
    }
    if (code !== 0) exitCode = code;
  } catch (err) {
    if (err instanceof CliExit) {
      exitCode = err.exitCode;
    } else if (err instanceof CliUsageError) {
      process.stderr.write(`${err.message}\n`);
      exitCode = 1;
    } else if (err instanceof Error && 'syscall' in err && err.syscall === 'uv_cwd') {
      console.error('The current working directory no longer exists. Run `cd` to another directory and try again.');
      exitCode = 1;
    } else {
      const code = (err as { code?: unknown })?.code;
      const message = err instanceof Error ? err.message : String(err);
      if (typeof code === 'string' && code.startsWith('STIM_')) {
        const remedy = err instanceof Error && 'remedy' in err && typeof err.remedy === 'string' ? err.remedy : null;
        console.error(`${code}: ${message}`);
        if (remedy && !message.endsWith(remedy)) console.error(remedy);
        if (json && !stdoutWritten) console.log(JSON.stringify({ code, message, remedy: remedy ?? undefined }));
      } else console.error(`Unexpected error: ${message.replace(/\.$/, '')}. Report it at ${pkg.bugs.url}`);
      exitCode = 1;
    }
  } finally {
    if (json) process.stdout.write = originalWrite;
    await end?.();
  }
  const hung = hungRead() !== null;
  if (hung && exitCode === undefined) exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  if (exitCode !== undefined) {
    await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
    if (hung && process.platform !== 'win32' && process.execve) {
      // process.exit joins every libuv thread pool thread, so it blocks on a filesystem read that never answers.
      process.emit('exit', exitCode);
      process.execve('/bin/sh', ['sh', '-c', `exit ${exitCode}`]);
    }
    process.exit(exitCode);
  }
}

if (!Reflect.get(globalThis, Symbol.for('stim.main'))) await main(process.argv);
