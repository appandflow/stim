import { captureProcessToken, waitForProcessExit } from '../process-identity.ts';

test('cancelling an exit wait rejects without waiting for the live owner to exit', async () => {
  const processToken = captureProcessToken(process.pid);
  if (!processToken) throw new Error('The test process identity is unavailable.');
  const controller = new AbortController();
  const cancelled = new Error('cancel process exit wait');
  const pending = waitForProcessExit({ pid: process.pid, processToken }, 1000, controller.signal);
  controller.abort(cancelled);
  await expect(pending).rejects.toBe(cancelled);
});
