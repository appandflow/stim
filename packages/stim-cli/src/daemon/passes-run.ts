import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { relaunchWithLogFile } from '../detached-entry.ts';
import { runPassesInProcess } from './passes.ts';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!relaunchWithLogFile(process.argv.slice(2))) await runPassesInProcess(process.argv[2] ?? 'command');
}
