#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { runId, trace } from '@stim-cli/core/state';
import { debugLog } from '../src/debug-log.ts';
import { refuseRelativeStimPaths } from '../src/workspace/config.ts';

type CommandModule = { default: (program: Command, version: string) => void };

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
]);

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

export interface MainContext {
  /** The version of the copy the person ran, when a router runs this build in its place. */
  invokedVersion?: string;
  /** Called instead of throwing when this build's CLI code cannot load, so a router can run another copy. */
  onLoadError?: (error: unknown) => unknown;
}

/** Runs the CLI for `argv`, in `process.argv`'s shape. */
export async function main(argv: string[], ctx: MainContext = {}): Promise<void> {
  const program = new Command();
  program.name('stim').description('Isolated React Native dev environments per project/worktree').version(pkg.version);

  try {
    refuseRelativeStimPaths();
    process.env.STIM_RUN_ID = runId();
    const first = argv[2];
    const loadCommand = commands.get((first === 'help' ? argv[3] : first) ?? '');
    if (loadCommand) {
      (await loadCommand()).default(program, pkg.version);
    } else if (first !== '--version' && first !== '-V') {
      const modules = await Promise.all([...commands.values()].map((load) => load()));
      for (const module of modules) module.default(program, pkg.version);
    }
    program.hook('preAction', async (_command, action) => {
      const path: string[] = [];
      for (let each: Command | null = action; each?.parent; each = each.parent) path.unshift(each.name());
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
    });
    await program.parseAsync(argv);
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (typeof code === 'string' && code.startsWith('STIM_')) console.error(`${code}: ${message}`);
    else console.error(`Unexpected error: ${message.replace(/\.$/, '')}. Report it at ${pkg.bugs.url}`);
    process.exit(1);
  }
}

if (!Reflect.get(globalThis, Symbol.for('stim.main'))) await main(process.argv);
