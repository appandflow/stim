export const id = 'fixture';

export function createTransport({ options }) {
  const addresses = options.addresses ?? ['127.0.0.2'];
  const emit = options.break === 'event' ? { addresses, notify() {} } : { addresses };
  return {
    id,
    bindAddresses: () => addresses,
    watch(listener) {
      const timer = setImmediate(() => listener(emit));
      return () => clearImmediate(timer);
    },
    async identify({ headers }) {
      if (options.break === 'identify') return { id: 'node', name: 'node', user() {} };
      const node = headers['x-fixture-node'];
      return typeof node === 'string' ? { id: node, name: node, user: 'fixture' } : null;
    },
    async resolve({ name, credential }) {
      return { unresolved: `no machine named ${name} for ${credential.machine}` };
    },
    close() {},
  };
}
