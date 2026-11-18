import type { MessagePort } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { StatusFeed } from '../src/status-feed.ts';

it.each([
  { posted: 'nothing, so no child could have started, is a clean stop', messages: [], failure: null },
  {
    posted: 'started, is an unverified stop',
    messages: [{ started: true }],
    failure: 'The status worker ended before confirming that its adb and simctl children exited.',
  },
])('a status worker port that closes on stop after it posted $posted', async ({ messages, failure }) => {
  const feed = new StatusFeed({
    worker: 'unused',
    env: {},
    cwd: '/',
    spawn: ({ port }: { port: MessagePort }) => {
      for (const message of messages) port.postMessage(message);
      port.on('message', (message) => {
        if (message === 'stop') port.close();
      });
    },
  });
  feed.hold();
  const outcome = await feed.close().then(
    () => null,
    (error: Error) => error.message,
  );
  expect(outcome).toBe(failure);
});
