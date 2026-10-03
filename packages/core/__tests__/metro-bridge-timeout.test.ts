import { connect, Socket, type AddressInfo } from 'node:net';
import { createMetroBridge } from '../metro-bridge.ts';

vi.mock('node:net', async (original) => {
  const actual = await original<typeof import('node:net')>();
  return { ...actual, connect: vi.fn<typeof actual.connect>(actual.connect) };
});

test('closes the real accepted worker socket when its pending gateway connection times out', async () => {
  const pending = new Socket();
  let dialed!: () => void;
  const dialing = new Promise<void>((resolve) => (dialed = resolve));
  vi.mocked(connect).mockImplementationOnce(() => {
    dialed();
    return pending;
  });
  const bridge = createMetroBridge({ gatewayPort: 12345, peer: '127.0.0.1', secret: 'a'.repeat(64) });
  await new Promise<void>((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
  const client = new Socket();
  const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
  client.on('error', () => {});
  try {
    client.connect((bridge.server.address() as AddressInfo).port, '127.0.0.1');
    await dialing;
    pending.emit('timeout');
    await closed;
    expect(
      await new Promise<number>((resolve, reject) =>
        bridge.server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
      ),
    ).toBe(0);
  } finally {
    client.destroy();
    pending.destroy();
    await bridge.close();
  }
});
