#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
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
  ['reload', () => import('../src/commands/reload.ts')],
  ['device', () => import('../src/commands/device.ts')],
  ['logs', () => import('../src/commands/logs.ts')],
  ['status', () => import('../src/commands/status.ts')],
  ['stats', () => import('../src/commands/stats.ts')],
  ['gc', () => import('../src/commands/gc.ts')],
  ['guide', () => import('../src/commands/guide.ts')],
]);

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

const program = new Command();
program.name('stim').description('Isolated React Native dev environments per project/worktree').version(pkg.version);

try {
  refuseRelativeStimPaths();
  const first = process.argv[2];
  const loadCommand = commands.get((first === 'help' ? process.argv[3] : first) ?? '');
  if (loadCommand) {
    (await loadCommand()).default(program, pkg.version);
  } else if (first !== '--version' && first !== '-V') {
    const modules = await Promise.all([...commands.values()].map((load) => load()));
    for (const module of modules) module.default(program, pkg.version);
  }
  await program.parseAsync();
} catch (err) {
  const code = (err as { code?: unknown })?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (typeof code === 'string' && code.startsWith('STIM_')) console.error(`${code}: ${message}`);
  else console.error(`Unexpected error: ${message.replace(/\.$/, '')}. Report it at ${pkg.bugs.url}`);
  process.exit(1);
}
