import { expect, it } from 'vitest';
import { StatusFeed } from '../src/status-feed.ts';

it('reports the stop as unverified when the status worker port closes before it confirms its children exited', async () => {
  const feed = new StatusFeed({
    worker: 'unused',
    env: {},
    cwd: '/',
    spawn: ({ port }) =>
      port.on('message', (message) => {
        if (message === 'stop') port.close();
      }),
  });
  feed.hold();
  await expect(feed.close()).rejects.toThrow('before confirming');
});
