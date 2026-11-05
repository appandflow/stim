import { writeFileSync } from 'node:fs';
import { getExecutor } from '../src/exec.ts';

const request: { file: string; args: string[]; started?: string; closed?: string } = JSON.parse(
  process.env.STIM_REPORT_CHILD ?? '',
);
const env = { ...process.env };
delete env.STIM_REPORT_CHILD;
const mark = (path: string | undefined) => {
  if (!path) return;
  try {
    writeFileSync(path, '');
  } catch {}
};
const child = getExecutor().spawn(request.file, request.args, { stdio: 'inherit', env });
child.once('spawn', () => {
  mark(request.started);
});
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('close', (status) => {
  mark(request.closed);
  process.exitCode = status ?? 1;
});
