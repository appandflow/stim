import { getExecutor } from '../src/exec.ts';

const request: { file: string; args: string[] } = JSON.parse(process.env.STIM_REPORT_CHILD ?? '');
const env = { ...process.env };
delete env.STIM_REPORT_CHILD;
const child = getExecutor().spawn(request.file, request.args, { stdio: 'inherit', env });
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('close', (status) => {
  process.exitCode = status ?? 1;
});
