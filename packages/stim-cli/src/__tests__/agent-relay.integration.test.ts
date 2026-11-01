import { once } from 'node:events';
import { createServer } from 'node:net';
import { openAgentRelay } from '../supervisor/agent-relay.ts';

const machine = 'local:10.0.0.92';
const session = '12345678-1234-4234-8234-123456789abc';

test('a relay listens again on the port an earlier relay of the session published, and on another one when that is taken', async () => {
  const first = openAgentRelay({ machine, session });
  const port = await first.port;
  first.close();
  await vi.waitFor(async () => {
    const again = openAgentRelay({ machine, session, port });
    try {
      expect(await again.port).toBe(port);
    } finally {
      again.close();
    }
  });

  const holder = createServer().listen(0, '127.0.0.1');
  await once(holder, 'listening');
  const address = holder.address();
  const held = typeof address === 'object' && address ? address.port : 0;
  const moved = openAgentRelay({ machine, session, port: held });
  try {
    expect(await moved.port).not.toBe(held);
  } finally {
    moved.close();
    holder.close();
  }
});
