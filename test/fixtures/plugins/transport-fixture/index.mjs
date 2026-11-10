import { createRequire } from 'node:module';

export const id = 'fixture';

class FixtureTransport {
  id = id;

  constructor(options) {
    this.options = options;
    this.addresses = options.addresses ?? ['127.0.0.2'];
    if (options.break === 'member') this.bindAddresses = 42;
  }

  bindAddresses() {
    return this.addresses;
  }

  watch(listener) {
    const { addresses } = this;
    const timer = setImmediate(() =>
      listener(this.options.break === 'event' ? { addresses, notify() {} } : { addresses }),
    );
    return this.options.break === 'watch' ? undefined : () => clearImmediate(timer);
  }

  async identify({ headers }) {
    if (this.options.break === 'identify') return { id: 'node', name: 'node', user() {} };
    const node = headers['x-fixture-node'];
    return typeof node === 'string' ? { id: node, name: node, user: 'fixture' } : null;
  }

  async resolve({ name, credential }) {
    return { unresolved: `no machine named ${name} for ${credential.machine}` };
  }

  close() {}
}

export function createTransport({ options }) {
  if (options.break === 'require') createRequire(import.meta.url)('stim/plugin');
  return new FixtureTransport(options);
}
