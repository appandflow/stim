import { spawn } from 'node:child_process';
import { captureProcessToken, childExitedWithin, waitForProcessExit } from '../process-identity.ts';

test('cancelling an exit wait rejects without waiting for the live owner to exit', async () => {
  const processToken = captureProcessToken(process.pid);
  if (!processToken) throw new Error('The test process identity is unavailable.');
  const controller = new AbortController();
  const cancelled = new Error('cancel process exit wait');
  const pending = waitForProcessExit({ pid: process.pid, processToken }, 1000, controller.signal);
  controller.abort(cancelled);
  await expect(pending).rejects.toBe(cancelled);
});

test('a NOT_FOUND child counts as exited only once its own exit is seen', async () => {
  const exiting = spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore' });
  expect(await childExitedWithin(exiting, 5000)).toBe(true);
  const running = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    expect(await childExitedWithin(running, 50)).toBe(false);
  } finally {
    running.kill('SIGKILL');
  }
});
