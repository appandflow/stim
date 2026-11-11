# @stim-cli/agent-driver

The contract stim-server uses to start the tool a client's coding agent drives
hosted apps with. stim-server ships the first-party drivers as dependencies and
selects one with the hosting Mac's `hosting.agentDriver` setting:
[`@stim-cli/agent-driver-agent-device`](../agent-driver-agent-device/README.md).

Drivers are machine scope. stim-server resolves them from its own
dependencies, never from a project.

## Writing a driver

Declare `"stimPlugin": { "kinds": { "agent-driver": 1 } }` in package.json.
A driver package exports:

```js
export const id = 'my-tool';
export function createAgentDriver({ env, stateDir, claimRoot, device }) {
  return driver;
}
export const client = { access };
export async function recover({ env, stateDir, claimRoot }) {}
```

`createAgentDriver` returns a `HostedAgentDriver` named `id`, directly or
through a promise. Every argument and result of its members is
structured-clone-safe data, so a plugin host can run the driver in a worker
thread. `onExit` returns a function that stops the listener.

stim-server authenticates the client, its tailnet node and the session, then
proxies the request to the driver's own loopback listener that
`target(session)` names: `http://127.0.0.1:<port><path><rest>`, where `rest`
is what follows the session in the agent route. `target` resolves null for a
session without a live grant. The listener refuses a path that does not start
with `path`, and the driver confines every request to the one app or device it
issued the grant for. stim-server fills the grant's `path`. A driver that cannot
run or cannot scope an app rejects with an `Error` whose `code` is
`agent-driver-unavailable`; its message is shown to the client. `device` names
the hosted simulator or emulator when the driver serves one hosted device
session; without it the driver serves hosted macOS apps.

`client` is optional and runs on the Mac that placed the app. `access` turns a
grant into the contents of a mode 0600 file, which Stim writes as
`<id>-remote.json`, and a command that names that file. The command never
carries the token.

Stim reads the agent actions a driver records under
`<workspace>/<id>/sessions` itself.

`recover` is optional. stim-server calls it when it starts, once for each hosted
session area that holds the driver's `stateDir`, so the driver can stop what a
run left behind for a stim-server process that is gone. It rejects naming what
it could not resolve; stim-server logs that and continues.

`loadAgentDriverModule` and `loadAgentDriver` never throw. A failed or slow
import, a manifest with another kind integer, a module with another `id`, or a factory that throws
resolves to `{ unavailable }` with a one-line reason.

## Contract tests

```js
import { runAgentDriverContract } from 'stim/plugin';

const results = await runAgentDriverContract({
  reference: 'my-tool-driver',
  baseDir: process.cwd(),
  id: 'my-tool',
  unavailableInput: { env: { PATH: '' }, stateDir, claimRoot },
  app: { client: 'client', session, bundleId: 'dev.example.app', pid: 4242 },
  clientGrant,
});
for (const result of results) {
  if (!result.passed) throw new Error(`${result.name}: ${result.error}`);
}
```

The kit loads the module in a worker thread, where a runtime import of `stim`
fails, and calls each member across the thread boundary. The checks cover the
manifest's kind integer, idempotent `stop` and `revoke`, refusals before
`start`, no `target` without a grant, an `onExit` that stops,
`agent-driver-unavailable` when the tool is missing, and a client file that
keeps the token out of the command.
