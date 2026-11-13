import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stimdRecordFile } from '@stim-cli/core/state';
import { ensureMetroThroughStimd } from '../daemon/client.ts';
import { hostStimd } from '../stimd/attached.ts';
import { upsertProject } from '../workspace/config.ts';

export const livenessChild: string = import.meta.filename;

/** Hosts an attached stimd like `stim ci` does, freezes it under an admitted operation, and waits on it. */
async function run(): Promise<void> {
  const root = join(String(process.env.STIM_HOME), 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'p', dependencies: { 'react-native': '0.88.0' } }));
  writeFileSync(
    join(root, 'server.mjs'),
    "setTimeout(() => process.exit(0), 4000); import('node:http').then(({createServer}) => setTimeout(() => createServer((q, r) => r.end('packager-status:running')).listen(Number(process.argv[2]), '127.0.0.1'), 3000));",
  );
  writeFileSync(
    join(root, '.stim.json'),
    JSON.stringify({ metro: { command: [process.execPath, 'server.mjs', '{port}'], tunnel: 'off' } }),
  );
  upsertProject(root, {});
  const host = await hostStimd({ ...process.env, STIM_POOL_BOOTED_GRACE_MINUTES: '0' }, { handover: false });
  if (typeof host !== 'object' || host === null || !('instance' in host)) throw new Error('no attached stimd');
  const pid = JSON.parse(readFileSync(stimdRecordFile(), 'utf8')).pid;
  process.stdout.write(`stimd ${pid}\n`);
  setTimeout(() => process.kill(pid, 'SIGSTOP'), 700);
  const answer = await ensureMetroThroughStimd({ root, port: Number(process.argv[2]) }, 2500);
  process.stdout.write(`settled ${JSON.stringify(answer)}\n`);
  process.kill(pid, 'SIGCONT');
  await host.end();
}

if (process.argv[1] === livenessChild) await run();
