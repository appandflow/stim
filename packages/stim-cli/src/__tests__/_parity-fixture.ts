import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureProcessToken } from '../process-identity.ts';

/** Writes a parity record whose owner is a process that has already exited. */
export async function writeEndedOwnerRecord(base: string, repo: string): Promise<void> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const pid = child.pid ?? 0;
  const processToken = captureProcessToken(pid);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  writeFileSync(join(base, 'stim-parity.json'), JSON.stringify({ version: 1, repo, owner: { pid, processToken } }));
}
