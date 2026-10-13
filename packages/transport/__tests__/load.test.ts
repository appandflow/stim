import { expect, test } from 'vitest';
import { loadTransport, TRANSPORT_API_VERSION, type Transport } from '../index.ts';

const input = { env: {}, options: {} };
const transport: Transport = { id: 'fake', traits: { privateNetwork: false, tls: 'none', peerIdentity: false } };
const load = (namespace: unknown) => loadTransport({ reference: 'fake', load: async () => namespace, input });

test('creates the transport of a module with the current apiVersion, named or as its default export', async () => {
  const module = { apiVersion: TRANSPORT_API_VERSION, id: 'fake', createTransport: () => transport };
  expect(await load(module)).toEqual({ transport });
  expect(await load({ default: module })).toEqual({ transport });
});

test.each([
  [
    'a module that does not load',
    new Error('Cannot find module fake\nRequire stack: x'),
    /fake is not installed: Cannot find module fake$/,
  ],
  ['another apiVersion', { apiVersion: 2, createTransport: () => transport }, /expected apiVersion 1, found 2/],
  ['no factory', { apiVersion: TRANSPORT_API_VERSION }, /does not export createTransport/],
  [
    'a failing factory',
    {
      apiVersion: TRANSPORT_API_VERSION,
      createTransport: () => {
        throw new Error('no binary');
      },
    },
    /createTransport\(\) failed: no binary/,
  ],
  [
    'a factory that returns no transport',
    { apiVersion: TRANSPORT_API_VERSION, createTransport: () => ({}) },
    /did not return a transport/,
  ],
])('reports %s as unavailable instead of throwing', async (_case, namespace, reason) => {
  const result = await loadTransport({
    reference: 'fake',
    load: async () => {
      if (namespace instanceof Error) throw namespace;
      return namespace;
    },
    input,
  });
  expect(result).toEqual({ unavailable: expect.stringMatching(reason) });
});

test('reports a load that never settles as unavailable after the timeout', async () => {
  const result = await loadTransport({ reference: 'fake', load: () => new Promise(() => {}), input, timeoutMs: 20 });
  expect(result).toEqual({ unavailable: 'fake did not load within 20ms' });
});

test('refuses a transport whose capability is not a function', async () => {
  const module = {
    apiVersion: TRANSPORT_API_VERSION,
    createTransport: () => ({ ...transport, watch: true }),
  };
  expect(await load(module)).toEqual({ unavailable: 'fake: createTransport() did not return a transport' });
});

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
  const result = await loadTransport({ reference: 'fake', load: async () => module, input, timeoutMs: 10 });
  expect(result).toEqual({ unavailable: 'fake did not load within 10ms' });
  await closed;
});
