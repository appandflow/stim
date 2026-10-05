import { homedir } from 'node:os';
import { exclusiveClaimDir, sharedClaimDir } from '@stim-cli/core/ownership-claim';
import { runNodeCommand } from './stim-command.ts';

const READ_DIRECTORIES = `
import { readdirSync } from 'node:fs';
for (const path of process.argv.slice(1)) {
  try { readdirSync(path); } catch {}
}
`;

export async function checkRecorderStartup(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  const { outcome } = runNodeCommand(
    '--input-type=module',
    env,
    ['--eval', READ_DIRECTORIES, exclusiveClaimDir(root), sharedClaimDir(root)],
    homedir(),
    { timeoutMs: 10_000, maxOutputBytes: 1024 },
    'Reading recorder ownership directories',
  );
  const result = await outcome;
  if (!result.ok) {
    throw new Error(`${result.message} Check this server process's access to ${root}.`);
  }
}
