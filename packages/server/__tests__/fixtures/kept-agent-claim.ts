import { execFileSync } from 'node:child_process';
import { processGroupAlive } from '@stim-cli/core/ownership-claim';
import type { ProcessRecord } from '@stim-cli/core/process-identity';

export function keepAgentClaim(root: string): ProcessRecord {
  const script = `
import {spawn} from 'node:child_process';
import {tryAcquireClaim,setClaimChild} from ${JSON.stringify(new URL('../../../core/ownership-claim.ts', import.meta.url).href)};
import {captureProcessIdentity} from ${JSON.stringify(new URL('../../../core/process-identity.ts', import.meta.url).href)};
const claim=tryAcquireClaim({root:${JSON.stringify(root)},mode:'exclusive'}).acquired;
if(!claim)throw new Error('Fixture claim unavailable');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
child.unref();
const identity=captureProcessIdentity(child.pid);
if(!identity.ok)throw new Error('Fixture child identity unavailable');
const record={pid:child.pid,processToken:identity.token};
setClaimChild(claim,record);
process.stdout.write(JSON.stringify(record));
`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
}

export async function killKeptChild(child: ProcessRecord, timeoutMs = 10_000): Promise<void> {
  try {
    process.kill(child.pid, 'SIGKILL');
  } catch {}
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(child.pid)) {
    if (Date.now() > deadline) throw new Error(`process group ${child.pid} was not reaped in ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
