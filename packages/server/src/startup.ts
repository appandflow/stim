import { homedir } from 'node:os';
import { runNodeCommand } from './stim-command.ts';

export type StartupState = { state: 'pending' } | { state: 'ready' } | { state: 'degraded'; reason: string };

export const STARTUP_PROBE_MS = 10_000;
export const STARTUP_RETRY_MS = 30_000;
const KILL_WAIT_MS = 3000;
const LABEL = 'Reading the Stim home directories';

const READ_DIRECTORIES = `
import { readdirSync } from 'node:fs';
for (const path of process.argv.slice(1)) {
  try { readdirSync(path); } catch {}
}
`;

/**
 * Reads `directories` in a child process, so a read that never returns on a stalled volume cannot block this
 * process's event loop. `result` is null once every read returned, or why they did not; a read that returns an
 * error is not a stall and counts as done. It settles even when the child cannot be killed.
 */
export function probeDirectories(
  directories: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  home: string,
): { result: Promise<string | null>; cancel: () => void } {
  const run = runNodeCommand(
    '--input-type=module',
    env,
    ['--eval', READ_DIRECTORIES, ...directories],
    homedir(),
    { timeoutMs, maxOutputBytes: 1024 },
    LABEL,
  );
  const hint = `Check this server process's access to ${home}.`;
  let abandon!: () => void;
  const settled = new Promise<string | null>((resolve) => {
    const unstoppable = setTimeout(
      () => resolve(`${LABEL} did not finish within ${timeoutMs / 1000} s and could not be stopped. ${hint}`),
      timeoutMs + KILL_WAIT_MS,
    );
    abandon = () => {
      clearTimeout(unstoppable);
      resolve('stopped');
    };
    void run.outcome.finally(() => clearTimeout(unstoppable));
  });
  const result = Promise.race([
    run.outcome.then((outcome) => (outcome.ok ? null : `${outcome.message} ${hint}`)),
    settled,
  ]);
  return {
    result,
    cancel: () => {
      abandon();
      void run.cancel();
    },
  };
}
