# Remote device providers

Date: 2026-10-14. Status: proposed. Issue: #3736.

## Summary

Stim runs an app on a device that is not on this machine in three unrelated
ways: `--remote eas`, `--remote proxy`, and a simulator or emulator hosted on
a paired Mac. Each has its own selection, lifecycle, Metro path, viewing and
teardown code, and Argent Cloud would be a fourth with no seam to add it at.

This design adds a device provider contract, `@stim-cli/device-provider`, and
one first-party package per provider: `@stim-cli/device-provider-proxy`,
`@stim-cli/device-provider-eas`, `@stim-cli/device-provider-paired` and,
later, `@stim-cli/device-provider-argent-cloud`. It follows
`@stim-cli/transport` and `@stim-cli/agent-driver`: a versioned module, a few
required members, optional capabilities checked one by one, a loader that
never throws, and a contract test kit. Metro reach comes from the transport
plugins, and automation from the agent-driver contract.

The local simulator and emulator path is not a provider and does not change.

## Today

File references are to `packages/stim-cli/src` unless they name another
package.

| Concern             | `eas`                                                                                                                                                                                                                                                                            | `proxy`                                                                                                        | Paired Mac                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Selection           | `ios.remote` / `android.remote` = `eas` (`packages/core/state/settings-registry.ts:156,268`), a reserved word in a free machine-name pattern, parsed by `parseIosRemote` (`workspace/settings.ts:882`)                                                                           | same, value `proxy`                                                                                            | same, value a `remote.machines` name or `auto` (`settings-registry.ts:809`)                                                                            |
| Prerequisites       | agent-device on PATH, eas-cli 21.6.0+ (`engine/device-remote.ts:447-549`)                                                                                                                                                                                                        | agent-device on PATH, `AGENT_DEVICE_DAEMON_BASE_URL` and `_AUTH_TOKEN` from the environment only (`:465-494`)  | a `device-host` approval and a pinned credential (`device-host/hosted-client.ts:65-138`)                                                               |
| Build target        | always `arm64`: `resolveRemoteContext` sets `existingDaemon` only for proxy (`device-remote.ts:507`), and `readRemoteSimulatorArch` returns `arm64` without one (`engine/agent-device.ts:131-135`)                                                                               | arch from the daemon's health (`commands/ios/remote.ts:304`)                                                   | the offered choice's architecture and runtime (`device-host/hosted-native.ts:155-183`)                                                                 |
| Acquire             | `eas sim --name stim-<label>`, then `agent-device close` and `connect`, after the build (`device-remote.ts:256-335`, `commands/ios.ts:1026`)                                                                                                                                     | none; the daemon is the user's. `close` and `connect` on every run (`:315-335`)                                | `device-host.reserve` after the build (`hosted-native.ts:185-203,247-264`)                                                                             |
| Reuse               | the recorded session id, if `simulator:get` says it is live and on the same model; an unusable one is torn down and verified before a new one is created (`device-remote.ts:213-247,829`)                                                                                        | none                                                                                                           | `device-host.attach` to the recorded session (`hosted-native.ts:104-150`); sticky placement (`device-host/auto-placement.ts:161-176`)                  |
| Billing and limits  | metered while the session lives; `--max-duration-minutes` is supported (`engine/eas-simulator.ts:97`) but no caller sets it (#3739)                                                                                                                                              | none                                                                                                           | none; host caps `concurrency.maxDevices` and `server.devicesPaused`                                                                                    |
| Locks and record    | EAS project lock (machine, outer), then the workspace remote-session lock (inner); inside both: register the project, create and connect, then the claim in `~/.stim/machine/eas` and workspace `remoteDevice` (`device-remote.ts:659-808`)                                      | nothing is recorded; the in-run device record says `owned: true, remote: true` (`device-remote.ts:81,189-193`) | workspace `hostedIos` / `hostedAndroid` placement; the server's journal and created-device ledger in the session home                                  |
| Install and launch  | `agent-device install`, then `open <app> <url>` with Stim's dev-client link (`device-remote.ts:295-383`)                                                                                                                                                                         | same                                                                                                           | digest-chunk upload or same-node build handoff, then `device-host.app.launch` (`hosted-native.ts:316-397`)                                             |
| Metro               | a public origin: `metro.publicUrl`, a managed ngrok or cloudflared tunnel, or Expo's tunnel, gated by a bundle request (`ensureMetroReachable`, `device-remote.ts:1035-1133`; `engine/metro-reach.ts`)                                                                           | same, and `metro.tunnel: tailscale` is allowed                                                                 | a private bridge: client gateway on its tailnet address pinned to the worker (`device-host/metro-gateway.ts:47`), opened with `device-host.metro.open` |
| Automation          | Stim writes `agent-device.remote.json` in the workspace directory without the token (agent-device ADR 0007, `engine/agent-device.ts:11-58`) and passes the token only in the exec environment of its own agent-device calls (`daemonEnv`, `:59`)                                 | same; the agent uses the user's own `AGENT_DEVICE_DAEMON_*`                                                    | the host's `hosting.agentDriver` grant; the CLI writes the 0600 client file (`agentAccess`, `device-host/hosted-agent.ts:15-53`)                       |
| Viewing             | EAS `webPreviewUrl`, printed (`commands/ios/result.ts:413`)                                                                                                                                                                                                                      | none                                                                                                           | `device-host.frames.subscribe` (`packages/server/src/hosted-relay.ts:384`, `hosted-view.ts:49`)                                                        |
| Device logs         | none; the run says so (`commands/ios/launch.ts:1057`, `commands/android/launch.ts:933`)                                                                                                                                                                                          | none                                                                                                           | `device-host.logs.query`, pulled and followed (`device-host/hosted-logs.ts:136`, `hosted-logs-sync.ts`)                                                |
| Teardown            | `stop` and `reclaimProject` read `remoteDevice.sessionId`, end the session and drop claim and record only on verified stop (`teardownRemote`, `device-remote.ts:974-1033`; `commands/stop.ts:649-653`; `devices/reclaim.ts:103,140`)                                             | nothing; with no record, `stop` neither disconnects nor touches the daemon                                     | `device-host.stop`, final log pull, gateway close (`stopHostedNative`, `hosted-native.ts:417-487`)                                                     |
| Leaks               | `gc --delete`, in the current Expo project only, under every registered workspace's remote-session lock, stops a live `simulator:list` session only when its claim matches name and platform and no workspace records it (`commands/gc/eas-sessions.ts:155-160,163-270,303,352`) | none                                                                                                           | server reconciles stopped and parked sessions (`packages/server/src/device-host.ts:1465`)                                                              |
| Parking             | none                                                                                                                                                                                                                                                                             | none                                                                                                           | server parks and adopts for the same client (`device-host.ts:296-400,1349-1380`)                                                                       |
| Automatic placement | fallback when this machine is full and `remote.easFallback` is on (`device-host/placement.ts:95-96`; `engine/eas-fallback.ts:48`)                                                                                                                                                | never                                                                                                          | chosen by load and memory (`placement.ts:45-150`)                                                                                                      |

## Why this reverses the remote-device spec

`2026-08-26-remote-device-backend-design.md` rejected a `DeviceBackend`
interface: `DEFAULT_DEPS` in `commands/ios.ts` already listed the device
surface, and the remote backend replaced five entries with matching
signatures. That held for two backends that were one agent-device daemon.
It no longer holds:

- The command branches on the backend inside the seam: `remoteBackend !==
'eas'` (`commands/ios.ts:723`), `ensureRemoteBootOwned` only for eas
  (`:996-1012`), the remote boot deferred past the build (`:1026`), the Metro
  check (`:889-907`), and `failureRemedy` (`device-remote.ts:440-443`).
- Paired Macs bypass the dep seam entirely: `connectIosTarget` returns a
  `hostedTarget` and the run ends in `finishHostedIosRun` (`commands/ios.ts:1100`).
  `commands/android.ts` repeats both (`:102-105,1298`).
- Placement names one cloud backend in its type, `kind: 'eas'`
  (`device-host/placement.ts:32`).
- Argent Cloud is not an agent-device daemon. It is a reserved Mac running
  stock `simctl` through `sim-remote simctl`, closer to Stim's local iOS engine
  than to the daemon path, so it cannot hide behind `remoteIosDeps`.

The dep seam stays for the local path. Remote paths go through the provider
contract instead of overriding dep entries.

## Contract

```ts
export const apiVersion = 1;
export const id: string; // lowercase, e.g. 'eas'
export const optionsSchema: JSONSchema | undefined;
export function createDeviceProvider(input: {
  env: NodeJS.ProcessEnv;
  options: Record<string, unknown>; // remote.providers.<id>, machine scope
  host: ProviderHost;
}): DeviceProvider | Promise<DeviceProvider>;

interface ProviderHost {
  exec: Executor; // the CLI's exec wrapper, runFile with env and timeout
  note(line: string): void; // progress to stderr
  signal: AbortSignal; // the run's cancellation
  stateDir: string; // see "State directory"
  profilePath?: string; // phase 1 only: the legacy agent-device.remote.json
}

type Platform = 'ios' | 'android';
type AppMode = 'development' | 'release' | 'process';
type Selectors = { deviceType?: string; runtime?: string } | { systemImage?: string; deviceProfile?: string };
type Refusal = { refused: true; code: string; reason: string; remedy?: string };
type Handle = { lease: string; [fact: string]: string | number | boolean | null };
type Result = { ok: true } | { ok: false; code: string; reason: string; remedy?: string };
type LaunchResult =
  | { ok: true; launched: true | 'bundling' | 'unverified'; mode: 'launch' | 'openurl'; url?: string }
  | { ok: false; code: string; reason: string; remedy?: string }; // invariant 11; false stays reserved
interface Description {
  platforms: Platform[];
  modes: AppMode[];
  buildTarget: { architecture: 'arm64' | 'x86_64'; runtime?: string } | null; // null: decided by capacity
  billing: 'none' | 'metered' | 'reserved';
  owns: 'device' | 'lease' | 'nothing';
  targets: 'none' | 'required' | 'optional';
  exclusive: boolean; // false when the service shares the lease with others
  limits: {
    maxLeaseMinutes: number | null;
    idleReleaseSeconds: number | null;
    uploadBytes: number | null;
    acquireHoldMs: number; // longest acquire may hold the provider lock
    slots: 'default' | 'any';
  };
}
type ProviderAgentGrant =
  { driver: 'none' } | { driver: string; grant: Record<string, unknown>; baseUrl: string | null };

interface AcquireInput {
  workspace: string; // canonical root
  slot: string;
  platform: Platform;
  mode: AppMode;
  selectors: Selectors;
  label: string; // stim-<label> marker for services that name leases
  target: string | null; // the part after `<provider>/`, e.g. a Mac name
  maxLeaseMinutes: number | null;
}
type ReleaseResult = { status: 'released' } | { status: 'failed'; reason: string; remedy?: string };
interface MetroEndpoint {
  origin: string; // as the device must request it
  via: 'bridge' | 'public';
  gated: boolean; // a bundle request through `origin` reached this workspace's Metro
}
interface BuildHandoff {
  node: string;
  token: string;
  sha256: string;
} // today's device-host handoff
interface Offer {
  target: string | null;
  choice: {
    architecture: string;
    runtime?: string;
    deviceType?: string;
    systemImage?: string;
    deviceProfile?: string;
  };
  capacity: { available: number | null };
  resources: { loadPerCore: number | null; memoryFreeBytes: number | null; memoryPressure: string | null };
}
type Unusable = { usable: false; target: string | null; code: string; reason: string };
interface LogPage {
  records: unknown[];
  cursor: unknown;
  complete: boolean;
} // records in Stim's NDJSON shape

interface DeviceProvider {
  id: string;
  describe(input: { platform: Platform; selectors: Selectors; target: string | null }): Promise<Description>;
  acquire(input: AcquireInput): Promise<{ handle: Handle } | Refusal>;
  reuse(handle: Handle, input: AcquireInput): Promise<{ handle: Handle } | { gone: true } | Refusal>;
  release(handle: Handle, input: { reason: 'stop' | 'remove' | 'gc' | 'abandon' }): Promise<ReleaseResult>;
  install(handle: Handle, artifact: { path: string; sha256: string; handoff?: BuildHandoff }): Promise<Result>;
  launch(
    handle: Handle,
    input: { appId: string; mode: AppMode; metro: MetroEndpoint | null; devClientScheme?: string },
  ): Promise<LaunchResult>;
  agentDriver(handle: Handle): Promise<ProviderAgentGrant>;

  view?: { url(handle: Handle): Promise<string | null> } | { frames: true }; // frames: paired only, see Paired Macs
  metroBridge?: {
    open(handle: Handle, input: { port: number }): Promise<MetroEndpoint>;
    close(handle: Handle): Promise<void>;
  };
  parking?: { park(handle: Handle): Promise<ReleaseResult> }; // adoption happens inside acquire
  logs?: { pull(handle: Handle, input: { cursor: unknown; final: boolean }): Promise<LogPage> };
  capacity?(input: {
    target: string | null;
    platform: Platform;
    selectors: Selectors;
    mode: AppMode;
  }): Promise<Offer | Unusable>;
  inventory?(input: { workspace: string }): Promise<{ lease: string; name: string | null; platform: Platform }[]>;
}
```

`Description.buildTarget` is what the build uses before any lease exists:
eas returns the constant `arm64`, which is what eas builds for today; proxy
reads the daemon's health; paired returns null and takes the architecture
from its `capacity` offer, as today.

A `Handle` is plain JSON: the provider's lease id and the facts needed to
reuse and release it. It never carries a credential. A provider instance
lives for one CLI process, so whatever a connection needs in memory is set up
by the `acquire` or `reuse` call of that process: for eas and proxy, that is
where `agent-device close` and `connect` run, with the token re-read from
`eas simulator:get` or the environment and passed only in the exec
environment. `install`, `launch` and `agentDriver` on a handle this instance
did not acquire or reuse refuse with "not connected", as `notConnected` does
today (`device-remote.ts:818`).

`stop`, `worktree remove` and `gc` run in a process that did not connect, so
these members must work on a recorded handle without `reuse`: `release`,
`logs.pull`, `metroBridge.close`, `view.url` and `inventory`. `install`,
`launch` and `agentDriver` need a connected handle.

A record from an older eas CLI has `sessionId` and no `handle`; the CLI builds
the handle `{ lease: sessionId }`. When a record has both and they disagree,
`sessionId` wins, because it is what older CLIs stop.

**State directory.** `stateDir` is
`$STIM_HOME/workspaces/<id>/providers/<provider>/<slot>/`, which the CLI
creates and removes after a verified release. Providers write only
non-secret files there and nothing outside it. Phase 1 passes eas and proxy
the legacy `agent-device.remote.json` in the workspace directory separately,
as `profilePath`, so the agent's `--remote-config` path does not change; the
contract kit exempts that one path, and the CLI never removes it, as today.
Paired maps `stateDir` to its existing `hosted-ios/<slot>/` and
`hosted-android/<slot>/` directories (`device-host/hosted-native.ts:70-74`,
`guide/lifecycle.ts:510`).

`agentDriver` returns a `ProviderAgentGrant`, never a file path or file
contents. It is a local type, not `HostedAgentGrant`, which is the
device-host wire type `parseHostedAgentGrant` checks. The CLI turns a grant
into the agent's 0600 client file and command through the named driver's
`client` capability, as `agentAccess` does for paired Macs, so the CLI stays
the only writer of secret files. Paired wraps the host's `HostedAgentGrant`
and the base URL `agentAccess` derives today from the machine credential. eas and proxy return
`{ driver: 'none' }` in phase 1 and keep today's behavior: the profile without
a token, the token only in Stim's own exec environment, and the user's own
environment for an agent on a proxy daemon.

`loadDeviceProvider` imports a module under the 10-second deadline the other
contracts use and resolves to `{ unavailable: reason }` for a failed or slow
import, another `apiVersion` or `id`, or a throwing factory.
`runDeviceProviderContract` checks what every provider needs regardless of
host: `describe` before `acquire`; `release` and `metroBridge.close` are
idempotent; `install`, `launch` and `agentDriver` refuse an unknown or
unconnected handle; the members listed above work on an unconnected handle;
a handle round-trips through JSON; an optional capability is either absent or
complete. The kit seeds known secrets (the credential environment, a
`BuildHandoff.token`, a grant's token) and fails when any appears in a handle,
in `stateDir`, in `profilePath`, or outside `stateDir`.

The contract package has no runtime dependencies and imports payload types
from `@stim-cli/core/state` only, as `@stim-cli/agent-driver` does.

### What Stim keeps

The CLI keeps every state write and every ownership decision. A provider
returns a handle; the CLI records it.

**Locks.** A provider gets a machine claim and the two locks if and only if
`billing !== 'none'`: the provider's machine lock (today's EAS project lock)
first and the workspace remote-session lock inside it, as
`ensureRemoteBootOwned` does. The wait on the outer lock gives up after the
provider's `limits.acquireHoldMs`, which replaces the EAS-only
`EAS_START_HOLD_MS` (`device-remote.ts:653`); eas returns today's value. eas registers
the project inside both locks, before `acquire`, as today; other providers
register before. Placement and builds run outside these locks.

**Claim timing.** Inside both locks the CLI calls `acquire` (for eas: create
and connect), then writes a claim to `~/.stim/machine/<provider>/` and the
workspace record. The claim root ignores `STIM_HOME` like the EAS ledger and
keeps its `STIM_TEST_GUARD_REAL_EAS_ROOT` guard. If either write fails, the
CLI calls `release(handle, { reason: 'abandon' })`, and keeps the claim when
that fails too. Phase 1 keeps today's order exactly. Providers with
`billing: 'none'` take no claim: proxy writes no claim and no record, so
`stop` keeps not touching it; paired keeps its record only in `hostedIos` /
`hostedAndroid` under today's hosted locking, and has no client-side gc
release, because the server reconciles its own sessions.

**Record.** eas keeps `remoteDevice` as it is today, `{ platform, sessionId,
startedAt, webPreviewUrl?, deviceType? }`, which `commands/stop.ts:649`,
`devices/reclaim.ts:103` and `commands/gc/eas-sessions.ts:155-160` read, and
adds `provider: 'eas'` and `handle` beside them, so older CLIs still find and
stop the session. A provider with no legacy record (argent-cloud) records
under a new state key, `providerDevices`, `{ [slot]: { provider, platform,
handle, startedAt } }`, which older CLIs do not read. It is never written into
`remoteDevice`, where an older CLI would treat the lease id as an EAS session
id. The name avoids `remoteDevices`, which is already the status payload
field (`packages/core/state/status.ts:429-436`).

Downgrade window: an older `stop` ignores `providerDevices` and reports
success while an Argent machine stays reserved, until its idle release or 24
hour cap. A newer `gc` recovers it only after the workspace record is gone.

**Reuse.** On `{ gone: true }` the CLI calls `release` for the recorded handle,
as `ensureBooted` tears down an unusable EAS session today, drops the claim and
record only on a verified release, and only then calls `acquire`. A failed
release refuses the run and keeps the record.

**Teardown and gc.** `stop`, `worktree remove` and `gc` call `release` only for
recorded handles and drop the record only on a verified release. `gc --delete`
keeps every check it has today and applies them per provider: it runs only for
the current project scope, takes every registered workspace's remote-session
lock before its final sweep, and releases a lease only when `inventory` lists
it live, the claim matches its name and platform, and no workspace records it.
Holding those locks is what keeps `gc` out of the window between the claim
write and the record write. `inventory` entries with no claim are reported,
never released.

**Metro.** The CLI passes `launch` a `MetroEndpoint`. Without `metroBridge`,
the public origin step stays where it is, before the build:
`ensureMetroReachable` runs in `prepareMetro` (`commands/ios.ts:853-907`),
which runtime preparation calls at `:794`. It uses `engine/metro-reach.ts`
until the transports' `expose({ purpose: 'metro' })` (phase 5 of the
transports spec) replaces it. Only `metroBridge.open` runs after `acquire`,
because a bridge needs the lease. Launch status
semantics do not change: `true` only from a proven bundle request on this
workspace's Metro, or, for a release build or an app with no Metro, positive
evidence that its process is running.

## Commands

`stim ios` and `stim android` get one remote path:

```text
placement -> describe (build target) -> public Metro origin -> build -> locks
-> reuse or acquire -> record -> metroBridge.open -> install -> launch
-> agentDriver -> logs, view
```

`acquire` stays after the build, because an agent-device daemon exits five
minutes after its last request (#1212) and Argent Cloud releases an idle
machine after 15. `acquire` takes `maxLeaseMinutes`, null today; for eas it
becomes `--max-duration-minutes`, and #3739 decides where its value comes from. The
local path keeps its dep seam and phase order.

- `stop` and `worktree remove`: `release` for each recorded handle, with
  `logs.pull({ final: true })` first when present.
- `logs`: `logs.pull` when present; otherwise the existing "device logs come
  from the provider" notice.
- `status`: `view.url` when present.
- `doctor`: each configured provider's `describe` and a `capacity` probe.
- `stop` still never deletes a device. Releasing a `metered` or `reserved`
  lease is the existing recorded exception for remote sessions, now stated
  per `billing` instead of per backend name.

## Placement

`decideDevicePlacement` keeps its rules and loses `kind: 'eas'`:

- Free members first: this machine, then paired Macs by load and memory, as
  today. The `paired` provider's `capacity` is called once per
  `remote.machines` entry, with that entry as `target`.
- A provider whose `billing` is not `none` is only a fallback, used when this
  machine is at its cap and no free member admits the run. The fallback list
  is `remote.easFallback` in phase 1. A list setting naming providers in order
  replaces it later; that rename is a settings contract change and needs its
  own decision.
- A provider without `capacity` is never placed automatically (`proxy`).
- `--plan` reports a provider without a probe as unknown, as it does for EAS
  now (`device-host/plan-placement.ts:66-70`).

## Settings

Today `ios.remote` and `android.remote` are a free string matching
`TAILNET_MACHINE_PATTERN` (`packages/core/state/tailnet.ts:5`, a machine name
with an optional `:<port>`), in every scope. `eas`, `proxy`, `auto` and `local`
are reserved words that `parseIosRemote` reads before treating the value as a
machine name. Validation does not check that a machine is configured.

- Phase 1 changes nothing in settings.
- Phase 2 adds `<provider>/<target>`, for example `paired/studio`. `/` cannot
  appear in a tailnet machine name or in the `:<port>` suffix, so it collides
  with neither, and it also names a Mac whose name equals a provider id. The
  pattern accepts `<id>/<machine pattern>` for listed provider ids only, so
  the JSON Schema still rejects a typo in the provider part. `paired` and,
  in phase 3, `argent-cloud` become reserved bare words; `doctor` reports a
  `remote.machines` entry they shadow.
- `remote.providers.<id>` holds provider options, machine scope only, with
  each `optionsSchema` joined into `settings.schema.json`. It arrives with the
  first provider that has options; `eas` and `proxy` have none. Credentials
  never live in settings: they stay in the provider's own tool or environment
  (eas-cli login, `AGENT_DEVICE_DAEMON_*`, `SIM_REMOTE_API_KEY`).

A bare provider id whose `targets` is `required` (`paired`) refuses with
`STIM_BAD_ARG` and a remedy naming `<provider>/<target>` and the configured
`remote.machines` entries.

Settings contract changes, each recorded in the registry first:

1. phase 2: the `ios.remote` / `android.remote` pattern widens to accept
   `<provider>/<target>`. An older CLI rejects that value, so a committed
   value needs a minimum Stim version;
2. phase 2 and 3: new reserved words `paired` and `argent-cloud`, which change
   the meaning of a machine with that name;
3. later: `remote.providers.<id>`;
4. later, with its own decision: the fallback list replacing
   `remote.easFallback`.

Scope. A committed setting cannot point a provider at an endpoint or supply a
key, so a cloned repository cannot send a build to a device the user did not
set up. It can choose a provider: `ios.remote: eas` in a committed layer
already selects a billed EAS session, and phase 1 keeps that. Provider code
resolves from Stim's own dependencies, never from the project, as drivers and
transports do.

Open product decision for the maintainer: may a committed or repository
setting select a `metered` or `reserved` provider, or must that choice come
from the machine layer or a flag?

## Packaging

`stim` depends on every first-party provider package and imports one only
when a run selects it. `proxy` and `eas` are two packages, because a module
has one `id` and only `eas` needs eas-cli; the agent-device daemon client
(today `engine/agent-device.ts` and `remoteDeviceDeps`) lives in
`@stim-cli/device-provider-proxy` and the eas package depends on it. Each new
package needs npm to accept its first publish from the release workflow
before the first release that includes it.

## Paired Macs

`paired` implements every optional capability except `inventory`: `capacity` is `device-host.offer` for
one target, `acquire` is `device-host.reserve`, `reuse` is
`device-host.attach`, `release` is `device-host.stop`, `parking` is the
server's own, `metroBridge` is the tailnet gateway, `logs` is
`device-host.logs.query`, and `agentDriver` passes on the host's
`hosting.agentDriver` grant, which the CLI turns into the client file as
today. `view: { frames: true }` means the CLI does not stream frames itself:
Desktop and the phone subscribe through stim-server with
`device-host.frames.subscribe`, and `status` names the session.

It is only a protocol client. The remote stim-server enforces the invariants
on its own machine, whoever the client is:

- ownership: it creates devices in a private session home and acts only on
  devices its created-device ledger lists (`packages/server/src/device-host.ts:283-420`);
- teardown through the CLI's centralized teardown, under child-aware claims;
- parking and adoption only for the same client (`:296-400,1349-1380`);
- the same-build rule: a handoff is taken only from a build the same node
  ran, matching the client's manifest (`:905-946`, client check at
  `device-host/hosted-native.ts:338`).

So the client side owns nothing on the host: its handle is the session id,
and its only duty is to record it and release it. Its record stays in
`hostedIos` / `hostedAndroid`, where older CLIs read it. Phase 2 folds
`finishHostedIosRun` and `finishHostedAndroidRun` into the common path.

## Devices Stim does not own

A third-party provider cannot promise Stim's device ledger on its side, so
Stim's ownership rule applies to the handle instead of the device: Stim
creates, reuses and releases only handles it acquired and recorded, and never
one it found.

| Provider     | `owns`    | What Stim owns                                                                                                |
| ------------ | --------- | ------------------------------------------------------------------------------------------------------------- |
| eas          | `device`  | the session it created, named `stim-<label>`; ending it ends the device                                       |
| argent-cloud | `lease`   | only a machine this Stim acquired under its own `SIM_REMOTE_SESSION`, and the simulator UDID it created there |
| proxy        | `nothing` | nothing; no claim, no record, no release; from phase 2 the in-run device record stops saying `owned: true`    |
| paired       | `lease`   | the session id; the host owns the device                                                                      |

A provider promises: `acquire` creates a new lease and returns its id before
anything else can use it; `release` touches only that id and reports whether
it verified the result; a name marker such as `stim-<label>` is used where
the service has names, but never proves ownership, as with local devices.
A provider cannot promise exclusive use when the service shares the lease, so
`describe` states it and placement treats it as busy.

## Argent Cloud

Status: planned. Public facts, from the Argent repository's
`packages/docs/docs/cloud` (software-mansion/argent `d24e2f1`, 2026-10-13) and
argent.swmansion.com/cloud:

- Hosted iOS simulators only, on Macs assigned to one customer; no Android or
  physical devices. $299 per month per runner of up to 6 parallel simulators,
  with no hourly billing.
- Agents connect through `sim-remote`, published only as binaries for macOS
  and Linux (software-mansion/sim-remote-releases, v1.0.0; no source or
  license found). It authenticates with `SIM_REMOTE_API_KEY` (or `--api-key`)
  against `SIM_ROUTER_URL` and keeps the session token in a local daemon's
  memory.
- `login` / `acquire` reserve a machine (waiting up to 1800 s, `--no-wait`),
  `release` returns it, `logout` and `daemon stop` end the session, `attach`
  and `list-machines` share machines. `SIM_REMOTE_SESSION=<name>` runs one
  daemon per name.
- Limits: idle release after 15 minutes (`SIM_REMOTE_IDLE_TIMEOUT_SECS`, server
  16), `keepalive`, 24 hours per machine and per token, 1 GiB per upload.
  Machines are shared by a team; returning one erases every simulator on it
  and rebuilds the volume.
- `sim-remote simctl` passes `xcrun simctl` through, uploading for `install`
  and downloading for `io screenshot`. A machine has one pre-booted iPhone and
  allows `simctl create`.
- `reverse start <udid> <port>` lets the simulator reach a port on this
  machine; simulators on one machine share its network, so a port can be
  taken by another session.
- `logs <udid>` downloads crash reports, `system.log` and `log show --style
compact` output; `launch --console` streams app output.
- Argent's tool-server lists hosted simulators as `remote:<udid>` when
  `sim-remote` is logged in, and streams video over MoQ through the
  undocumented `sim-remote moq-info`.

Mapping:

- `acquire`: `login` under `SIM_REMOTE_SESSION=stim-<workspace id>-<slot>`,
  which reserves a new machine, then `simctl create` a `stim-<label>`
  simulator. The handle records the machine id, the session name and the
  simulator UDID; later calls address the UDID, never the name.
- Stim never runs `release`, `logout` or `daemon stop` for a machine it did
  not acquire under its own session name, since returning a machine erases
  every simulator on it, including teammates'. It never `attach`es to a
  machine, so a direct `ios.remote: argent-cloud` also gets a machine of its
  own and never uses one the user or Argent already holds.
- `release`: `SIM_REMOTE_SESSION=<recorded name> sim-remote logout`, which
  the docs say returns the machine and ends only that named session. Before
  it, `list-machines` under the same session must still show the recorded
  machine as current; otherwise the release fails and keeps the record. Known
  limitation: if a teammate or the user's Argent `attach`ed to that machine,
  `logout` still erases their simulators, and the docs give no way to see
  another session's attach. The idle release would erase them too.
- `reuse`: the named session still holds the recorded machine and the UDID
  still exists; otherwise `{ gone: true }`, followed by `release` as above.
- `limits.acquireHoldMs`: `acquire` runs `login --no-wait`, so it never holds
  the provider lock while waiting for a free machine; a busy team refuses the
  run with a retry remedy.
- `install` and `launch`: `simctl install` and `simctl openurl` with Stim's
  dev-client link. `metroBridge`: `reverse start` with the device origin
  `http://localhost:<port>`. `logs`: poll `sim-remote logs`. `billing`:
  `reserved`. `simctl` argument lists are verified against
  `sim-remote simctl` once (invariant 9).
- `agentDriver`: a grant for `@stim-cli/agent-driver-argent`, a client-only
  driver package. No Argent agent driver exists today: the agent-drivers spec
  rejected Argent as a hosted, server-side driver because its tool-server
  injects into every booted simulator and cannot be confined. The new package
  implements only the agent-driver contract's optional `client` capability:
  from a grant naming the session and the simulator UDID it writes the 0600
  config file and the command the agent runs. Stim never writes the API key;
  the agent's `sim-remote` reads `SIM_REMOTE_API_KEY` from the user's
  environment. The provider returns
  `{ driver: 'argent', grant: { session, udid }, baseUrl: null }`, a
  `ProviderAgentGrant`; `HostedAgentGrant` does not change.

Contract changes this needs, all in phase 3:

- `@stim-cli/agent-driver`: a client-only module kind. Today `moduleError`
  and `driverError` (`packages/agent-driver/driver.ts:120,137`) reject a
  module without `createAgentDriver`, so either `createAgentDriver` becomes
  optional for a module that exports `client`, or client-only modules get
  their own loader. The `client.access` input widens from
  `HostedAgentIssuedGrant` to the provider grant, and `baseUrl` becomes
  optional instead of being derived from a `DeviceHostMachineCredential`.
  Optional members keep `apiVersion` 1, as the other contracts added theirs;
  a loader that accepts a module without `createAgentDriver` is a different
  acceptance rule, so this design takes `apiVersion` 2 for client-only
  modules and keeps 1 for existing drivers, a decision to confirm when phase 3
  starts.
- The status payload's `RemoteDeviceState` (`packages/core/state/status.ts:429-436`,
  read by Desktop `StimKit/Status.swift` and `WorkspaceRow.swift`, documented
  in `guide/facts.ts:125-130`) has `backend: 'eas'` and `sessionId`. Its
  `backend` union gains `'argent-cloud'`, and `sessionId` carries the lease id
  for it, so older Desktop builds still decode the field.

Open questions:

- Is there an HTTP or JSON API behind `SIM_ROUTER_URL`, and machine-readable
  output for `login`, `acquire` and `list-machines`? Stim parses no free text.
- Can Stim hold a machine through a build without `keepalive` loops, or
  should it acquire only after the build, as for EAS?
- Is there a reservation smaller than a machine? Holding a whole machine for
  one workspace takes up to six simulators from the team.
- Does `simctl spawn <udid> log stream --style ndjson` pass through and
  stream? That decides whether device logs use Stim's existing collector.
- Can two sessions on one machine bind the same reverse port, and does the
  simulator see `localhost:<port>` or a remapped port?
- Can the user's local Argent tool-server drive a remote `sim-remote` session
  without injecting into this Mac's booted local simulators?
- How is the video stream exposed, for `view`?
- Where is `sim-remote`'s source, and under what license is it distributed?
- Android, and whether a customer can run its own build cache next to the
  simulators.

## Phases

1. Add `@stim-cli/device-provider`, and move `proxy` and `eas` into their
   packages behind it, with `ios.ts` and `android.ts` calling the contract
   instead of `remoteIosDeps` / `remoteAndroidDeps`. No behavior change: same
   lock order and claim timing, `remoteDevice` gains only additive fields,
   proxy records and releases nothing, no settings change. Check: the
   existing `device-remote`, `eas-simulator`, `eas-fallback`, ios, android,
   stop, reclaim and gc EAS-session tests pass unchanged except for import
   paths; a state file written by the new CLI is stopped by the previous
   release; the contract kit passes for both; settings and guide contract
   tests are unchanged; `pnpm run knip` finds the old modules gone.
2. Add `@stim-cli/device-provider-paired` and fold the hosted iOS and Android
   branches into the common path; placement asks providers for `capacity`;
   the `<provider>/<target>` form; the proxy in-run device record stops saying
   `owned: true`. Check: the hosted client, placement, plan and server
   device-host tests pass; settings validation and schema tests cover the new
   form; a field test against a paired Mac (debug and release, park and
   adopt, stop) per `docs/field-test-protocol.md`.
3. Add `@stim-cli/device-provider-argent-cloud` and
   `@stim-cli/agent-driver-argent` once the open questions above have answers.
   This includes the agent-driver and status payload changes above. Check:
   the device provider contract kit with a fake `sim-remote`, the
   agent-driver contract kit's client checks (0600 file, no secret in the
   command), and one field run of install, launch with Metro, agent access and
   release against a real machine.
