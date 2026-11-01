import { expect, test } from 'vitest';
import { loadTransport, TRANSPORT_API_VERSION, type Transport } from '../index.ts';

const input = { env: {}, options: {} };
const transport: Transport = { id: 'fake', traits: { privateNetwork: false, tls: 'none', peerIdentity: false } };

test('closes a transport that a factory creates after the load timed out', async () => {
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const module = {
    apiVersion: TRANSPORT_API_VERSION,
    createTransport: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { ...transport, close: finish };
    },
  };
  const pending = loadTransport({ reference: 'fake', load: async () => module, input, timeoutMs: 10 });
  await vi.advanceTimersByTimeAsync(10);
  const result = await pending;
  expect(result).toEqual({ unavailable: 'fake did not load within 10ms' });
  await vi.advanceTimersByTimeAsync(30);
  await closed;
});
