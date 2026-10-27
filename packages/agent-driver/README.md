# @stim-cli/agent-driver

The contract stim-server uses to start the tool a client's coding agent drives
hosted apps with. stim-server ships the first-party drivers as dependencies and
selects one with the hosting Mac's `hosting.agentDriver` setting:
[`@stim-cli/agent-driver-agent-device`](../agent-driver-agent-device/README.md).

Drivers are machine scope. stim-server resolves them from its own
dependencies, never from a project.

## Writing a driver

A driver package exports:

```js
export const apiVersion = 1;
export const id = 'my-tool';
export function createAgentDriver({ env, stateDir, claimRoot, device }) {
  return driver;
}
export const client = { configFile: 'my-tool-remote.json', access };
export const actions = { read };
```

`createAgentDriver` returns a `HostedAgentDriver` named `id`. stim-server
authenticates the client, its tailnet node and the session before it calls
`forward`; the driver confines every forwarded request to the one app or
device it issued the grant for, and refuses with `AgentDriverUnavailable`
when it cannot. `device` names the hosted simulator or emulator when the driver
serves one hosted device session; without it the driver serves hosted macOS
apps.

`client` is optional and runs on the Mac that placed the app. `access` turns a
grant into the contents of a mode 0600 file and a command that names that file.
The command never carries the token.

`actions` is optional. `read` returns the driver's recorded agent actions in a
workspace or archive directory as `agent` log records.

`loadAgentDriverModule` and `loadAgentDriver` never throw. A failed or slow
import, a module with another `apiVersion` or `id`, or a factory that throws
resolves to `{ unavailable }` with a one-line reason.

## Contract tests

```js
import { runAgentDriverContract } from '@stim-cli/agent-driver';

const results = await runAgentDriverContract({
  id: 'my-tool',
  load: () => import('my-tool-driver'),
  unavailableInput: { env: { PATH: '' }, stateDir, claimRoot },
  app: { client: 'client', session, bundleId: 'dev.example.app', pid: 4242 },
  clientGrant,
});
for (const result of results) {
  if (!result.passed) throw new Error(`${result.name}: ${result.error}`);
}
```

The checks cover the module shape, idempotent `stop` and `revoke`, refusals
before `start` and without a grant, `AgentDriverUnavailable` when the tool is
missing, and a client file that keeps the token out of the command.
