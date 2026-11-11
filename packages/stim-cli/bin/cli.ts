#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { runId, trace } from '@stim-cli/core/state';
import { debugLog } from '../src/debug-log.ts';
import { CliExit } from '../src/cli-operation.ts';
import { CliUsageError, runCli, type CliContext, type Op } from '../src/cli/define-op.ts';
import { refuseRelativeStimPaths } from '../src/workspace/config.ts';

if (process.argv[2] === '__stimd') {
  await (await import('../src/stimd/main.ts')).runStimdEntry(process.argv.slice(3));
  process.exit();
}

if (process.argv[2] === '__job') {
  const code = await (await import('../src/job/main.ts')).runJobEntry(process.argv.slice(3));
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
  process.exit(code);
}

type CommandModule = { default: ((program: Command, version: string) => void) | Op };

const commands = new Map<string, () => Promise<CommandModule>>([
  ['doctor', () => import('../src/commands/doctor.ts')],
  ['worktree', () => import('../src/commands/worktree.ts')],
  ['start', () => import('../src/commands/start.ts')],
  ['ports', () => import('../src/commands/ports.ts')],
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
  ['stats', () => import('../src/commands/stats.ts')],
  ['gc', () => import('../src/commands/gc.ts')],
  ['guide', () => import('../src/commands/guide.ts')],
  ['engine', () => import('../src/commands/engine.ts')],
  ['plugin', () => import('../src/commands/plugin.ts')],
]);

const opBacked = new WeakSet<Command>();

function register(program: Command, command: CommandModule['default'], before: CliContext['before']): void {
  if (typeof command === 'function') return command(program, pkg.version);
  const listed = program.command([command.name, command.arguments].filter(Boolean).join(' '));
  listed.description(command.description).allowExcessArguments();
  for (const option of Object.values(command.options)) listed.option(option.flags, option.description);
  listed.action(async (...params: unknown[]) => {
    const self = params.at(-1);
    const code =
      self instanceof Command ? await runCli(command, ['--', ...self.args], { version: pkg.version, before }) : 0;
    if (code !== 0) throw new CliExit(code);
  });
  opBacked.add(listed);
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

export interface MainContext {
  /** The version of the copy the person ran, when a router runs this build in its place. */
  invokedVersion?: string;
  /** Called instead of throwing when this build's CLI code cannot load, so a router can run another copy. */
  onLoadError?: (error: unknown) => unknown;
}

/** Runs the CLI for `argv`, in `process.argv`'s shape. */
export async function main(argv: string[], ctx: MainContext = {}): Promise<void> {
  Reflect.set(globalThis, Symbol.for('stim.cli'), true);
  const program = new Command();
  program.name('stim').description('Isolated React Native dev environments per project/worktree').version(pkg.version);

  let end: (() => unknown) | undefined;
  let exitCode: number | undefined;
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
        if (argv.includes('--json')) console.log(JSON.stringify(refusal));
        console.error(`${refusal.code}: ${refusal.message}`);
        console.error(refusal.remedy);
        process.exit(1);
      }
      end = entered.end;
    };
    const loadCommand = commands.get((first === 'help' ? argv[3] : first) ?? '');
    const loaded = await loadCommand?.();
    if (loaded && typeof loaded.default !== 'function') {
      const args = first === 'help' ? ['--help', ...argv.slice(4)] : argv.slice(3);
      const code = await runCli(loaded.default, args, { version: pkg.version, before });
      if (code !== 0) exitCode = code;
    } else {
      if (loaded) {
        register(program, loaded.default, before);
      } else if (first !== '--version' && first !== '-V') {
        const modules = await Promise.all([...commands.values()].map((load) => load()));
        for (const module of modules) register(program, module.default, before);
      }
      program.hook('preAction', (_command, action) => {
        if (opBacked.has(action)) return;
        const path: string[] = [];
        for (let each: Command | null = action; each?.parent; each = each.parent) path.unshift(each.name());
        return before(path);
      });
      await program.parseAsync(argv);
    }
  } catch (err) {
    if (err instanceof CliExit) {
      exitCode = err.exitCode;
    } else if (err instanceof CliUsageError) {
      process.stderr.write(`${err.message}\n`);
      exitCode = 1;
    } else {
      const code = (err as { code?: unknown })?.code;
      const message = err instanceof Error ? err.message : String(err);
      if (typeof code === 'string' && code.startsWith('STIM_')) console.error(`${code}: ${message}`);
      else console.error(`Unexpected error: ${message.replace(/\.$/, '')}. Report it at ${pkg.bugs.url}`);
      exitCode = 1;
    }
  } finally {
    await end?.();
  }
  if (exitCode !== undefined) {
    await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
    process.exit(exitCode);
  }
}

if (!Reflect.get(globalThis, Symbol.for('stim.main'))) await main(process.argv);
