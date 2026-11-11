export const id = 'driver-fixture';

class FixtureDriver {
  name = id;
  listener = null;

  async start() {
    throw Object.assign(new Error('driver-fixture is not installed on this host.'), {
      code: 'agent-driver-unavailable',
    });
  }

  async stop() {}

  async issue() {
    throw new Error('driver-fixture is not running.');
  }

  async revoke() {}

  async target() {
    return null;
  }

  onExit(listener) {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
}

export function createAgentDriver() {
  return new FixtureDriver();
}

export const client = {
  access({ grant, file }) {
    if (grant.driver !== id) return null;
    return {
      config: `${JSON.stringify({ url: grant.path, token: grant.token })}\n`,
      command: `driver-fixture --config ${file}`,
    };
  },
};
