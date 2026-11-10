import { expect, test } from 'vitest';
import { loadTransport, type Transport } from '../index.ts';

const input = { env: {}, options: {} };
const transport: Transport = { id: 'fake' };

test('closes a transport that a factory creates after the load timed out', async () => {
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const module = {
    createTransport: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { ...transport, close: finish };
    },
  };
  const pending = loadTransport({
    reference: 'fake',
    manifest: () => ({ stimPlugin: { kinds: { transport: 1 } } }),
    load: async () => module,
    input,
    timeoutMs: 10,
  });
  await vi.advanceTimersByTimeAsync(10);
  const result = await pending;
  expect(result).toEqual({ unavailable: 'the module did not load within 10ms' });
  await vi.advanceTimersByTimeAsync(30);
  await closed;
});
