import { fileURLToPath } from 'node:url';
import { runNodeCommand, type CommandLimits } from './stim-command.ts';

export function runStats(
  env: NodeJS.ProcessEnv,
  cwd: string,
  limits: CommandLimits,
): ReturnType<typeof runNodeCommand> {
  const entry = fileURLToPath(
    new URL(import.meta.url.endsWith('.ts') ? './stats-read.ts' : './stats-read.mjs', import.meta.url),
  );
  return runNodeCommand(entry, env, [], cwd, limits, 'stim stats', true);
}
