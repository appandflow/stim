export const id = 'driver-host-fixture';

class HostFixtureDriver {
  name = id;

  constructor({ host }) {
    this.host = host;
  }

  async start() {}

  async stop() {}

  async issue() {
    throw new Error('driver-host-fixture issues no grants.');
  }

  async revoke() {}

  async target() {
    return null;
  }

  onExit() {
    return () => {};
  }

  /** Calls the host member at the dotted path `member` from inside the worker. */
  use(member, ...args) {
    const [group, name] = member.split('.');
    return this.host[group][name](...args);
  }
}

export function createAgentDriver(input) {
  return new HostFixtureDriver(input);
}
