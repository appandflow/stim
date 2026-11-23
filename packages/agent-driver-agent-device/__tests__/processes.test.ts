import type { ExecFileException, ExecFileOptions } from 'node:child_process';
import { listProcesses } from '../processes.ts';

const run = vi.hoisted(() =>
  vi.fn<
    (
      file: string,
      args: string[],
      options: ExecFileOptions,
      done: (error: ExecFileException, stdout: string, stderr: string) => void,
    ) => void
  >(),
);
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: run,
}));

test.each([
  ['timeout', { killed: true, signal: 'SIGTERM' }, 'timed out after 10s, signal SIGTERM'],
  ['external termination', { killed: false, signal: 'SIGKILL' }, 'signal SIGKILL'],
  ['nonzero exit', { code: 1 }, 'exit code 1'],
  ['spawn failure', { code: 'ENOENT' }, 'ENOENT'],
  ['output limit', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'],
] satisfies [string, Partial<ExecFileException>, string][])(
  'reports the %s without exposing process output',
  async (_case, status, reason) => {
    run.mockImplementationOnce((_file, _args, _options, done) => {
      const cmd = '/bin/ps -A -ww -o pid=,pgid=,command=';
      const stderr = 'private diagnostic';
      done(Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), { cmd }, status), 'private arguments', stderr);
    });

    await expect(listProcesses('pid=,pgid=,command=')).rejects.toHaveProperty(
      'message',
      `Could not list processes with /bin/ps: ${reason}.`,
    );
  },
);
