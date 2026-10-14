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

| Concern             | `eas`                                                                                                                                                                                                  | `proxy`                                                                                                               | Paired Mac                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Selection           | `ios.remote` / `android.remote` = `eas` (`core/state/settings-registry.ts:156,268`), parsed by `parseIosRemote` (`workspace/settings.ts:882`)                                                          | same, value `proxy`                                                                                                   | same, value a `remote.machines` name or `auto` (`settings-registry.ts:809`)                                                                            |
| Prerequisites       | agent-device on PATH, eas-cli 21.6.0+ (`engine/device-remote.ts:447-549`)                                                                                                                              | agent-device on PATH, `AGENT_DEVICE_DAEMON_BASE_URL` and `_AUTH_TOKEN` from the environment only (`:465-494`)         | a `device-host` approval and a pinned credential (`device-host/hosted-client.ts:65-138`)                                                               |
| Build target        | arch from the daemon's health, once a session exists (`engine/agent-device.ts:131`)                                                                                                                    | arch from the daemon's health (`commands/ios/remote.ts:304`)                                                          | the offered choice's architecture and runtime (`device-host/hosted-native.ts:155-183`)                                                                 |
| Acquire             | `eas sim --name stim-<label>` after the build (`device-remote.ts:256-302`, `commands/ios.ts:1026`)                                                                                                     | none; the daemon is the user's                                                                                        | `device-host.reserve` after the build (`hosted-native.ts:185-203,247-264`)                                                                             |
| Reuse               | the recorded session id, if `simulator:get` says it is live and on the same model (`device-remote.ts:213-247,829`)                                                                                     | `agent-device close` then `connect` on every run (`:315-335`)                                                         | `device-host.attach` to the recorded session (`hosted-native.ts:104-150`); sticky placement (`device-host/auto-placement.ts:161-176`)                  |
| Billing and limits  | metered while the session lives; `--max-duration-minutes` is supported (`engine/eas-simulator.ts:97`) but no caller sets it                                                                            | none                                                                                                                  | none; host caps `concurrency.maxDevices` and `server.devicesPaused`                                                                                    |
| Ownership record    | workspace `remoteDevice` plus a claim in `~/.stim/machine/eas`, which ignores `STIM_HOME`, written under the EAS project lock (`ensureRemoteBootOwned`, `device-remote.ts:659-808`)                    | `remoteDevice` is not written, but the device record says `owned: true, remote: true` (`device-remote.ts:81,189-193`) | workspace `hostedIos` / `hostedAndroid` placement; the server's journal and created-device ledger in the session home                                  |
| Install and launch  | `agent-device install`, then `open <app> <url>` with Stim's dev-client link (`device-remote.ts:295-383`)                                                                                               | same                                                                                                                  | digest-chunk upload or same-node build handoff, then `device-host.app.launch` (`hosted-native.ts:316-397`)                                             |
| Metro               | a public origin: `metro.publicUrl`, a managed ngrok or cloudflared tunnel, or Expo's tunnel, gated by a bundle request (`ensureMetroReachable`, `device-remote.ts:1035-1133`; `engine/metro-reach.ts`) | same, and `metro.tunnel: tailscale` is allowed                                                                        | a private bridge: client gateway on its tailnet address pinned to the worker (`device-host/metro-gateway.ts:47`), opened with `device-host.metro.open` |
| Automation          | agent-device, through the profile Stim writes (`device-remote.ts:177`)                                                                                                                                 | same                                                                                                                  | whatever `hosting.agentDriver` names on the host, written beside the placement (`hosted-native.ts:397-408`)                                            |
| Viewing             | EAS `webPreviewUrl`, printed (`commands/ios/result.ts:413`)                                                                                                                                            | none                                                                                                                  | `device-host.frames.subscribe` (`packages/server/src/hosted-relay.ts:384`, `hosted-view.ts:49`)                                                        |
| Device logs         | none; the run says so (`commands/ios/launch.ts:1057`, `commands/android/launch.ts:933`)                                                                                                                | none                                                                                                                  | `device-host.logs.query`, pulled and followed (`device-host/hosted-logs.ts:136`, `hosted-logs-sync.ts`)                                                |
| Teardown            | `stop` and `reclaimProject` end the session and drop the claim only on verified stop (`teardownRemote`, `device-remote.ts:974-1033`; `commands/stop.ts:649-653`; `devices/reclaim.ts:140`)             | `agent-device disconnect`                                                                                             | `device-host.stop`, final log pull, gateway close (`stopHostedNative`, `hosted-native.ts:417-487`)                                                     |
| Leaks               | `gc` stops ledger-claimed sessions that no workspace records (`commands/gc/eas-sessions.ts:163,352`)                                                                                                   | none                                                                                                                  | server reconciles stopped and parked sessions (`packages/server/src/device-host.ts:1465`)                                                              |
| Parking             | none                                                                                                                                                                                                   | none                                                                                                                  | server parks and adopts for the same client (`device-host.ts:296-400,1349-1380`)                                                                       |
| Automatic placement | fallback when this machine is full and `remote.easFallback` is on (`device-host/placement.ts:95-96`; `engine/eas-fallback.ts:48`)                                                                      | never                                                                                                                 | chosen by load and memory (`placement.ts:45-150`)                                                                                                      |

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
  host: ProviderHost; // exec, notices, cancellation signal, a private state dir
}): DeviceProvider | Promise<DeviceProvider>;

interface DeviceProvider {
  id: string;
  describe(input: { platform: Platform; selectors: Selectors; target: string | null }): Promise<Description>;
  acquire(input: AcquireInput): Promise<{ handle: Handle } | Refusal>;
  reuse(handle: Handle, input: AcquireInput): Promise<{ handle: Handle } | { gone: true } | Refusal>;
  release(handle: Handle, input: { reason: 'stop' | 'remove' | 'gc' | 'abandon' }): Promise<ReleaseResult>;
  install(
    handle: Handle,
    artifact: { platform: Platform; path: string; digest: string; handoff?: BuildHandoff },
  ): Promise<Result>;
  launch(
    handle: Handle,
    input: { appId: string; mode: AppMode; metro: MetroEndpoint | null; devClientScheme?: string },
  ): Promise<LaunchResult>;
  agentDriver(handle: Handle): Promise<HostedAgentAccess>; // a driver name, or { driver: 'none' }

  view?: { url(handle: Handle): Promise<string | null> } | { frames: true };
  metroBridge?: {
    open(handle: Handle, input: { port: number }): Promise<MetroEndpoint>;
    close(handle: Handle): Promise<void>;
  };
  parking?: { park(handle: Handle): Promise<ReleaseResult> }; // adoption happens inside acquire
  logs?: { pull(handle: Handle, input: { cursor: unknown; final: boolean }): Promise<LogPage> };
  capacity?(input: { platform: Platform; selectors: Selectors; mode: AppMode }): Promise<Offer | Unusable>;
  inventory?(): Promise<{ id: string; name: string | null }[]>; // leases this account holds, for gc
}
```

`Description` carries the platforms and app modes the provider takes, the
build target (architecture, and runtime when known), `billing:
'none' | 'metered' | 'reserved'`, `owns: 'device' | 'lease' | 'nothing'`,
and limits (`maxLeaseMinutes`, `idleReleaseSeconds`, `uploadBytes`,
`slots: 'default' | 'any'`). A `Handle` is a small JSON object with the
provider's lease id and the facts needed to reuse and release it. It never
carries a credential: providers re-read tokens from their own tool, as EAS
does with `simulator:get` today.

`loadDeviceProvider` imports a module under the 10-second deadline the other
contracts use and resolves to `{ unavailable: reason }` for a failed or slow
import, another `apiVersion` or `id`, or a throwing factory.
`runDeviceProviderContract` checks what every provider needs regardless of
host: `describe` before `acquire`; `release` and `metroBridge.close` are
idempotent; `install` and `launch` refuse an unknown handle; a handle
round-trips through JSON and contains no value from the credential
environment the kit sets; an optional capability is either absent or
complete.

The contract package has no runtime dependencies and imports payload types
from `@stim-cli/core/state` only, as `@stim-cli/agent-driver` does.

### What Stim keeps

The CLI keeps every state write and every ownership decision. A provider
returns a handle; the CLI records it.

1. Under the workspace process lock, and for `billing !== 'none'` also under
   a per-provider machine lock (today's EAS project lock), the CLI calls
   `acquire`.
2. Before any other call on that handle, the CLI writes a claim to
   `~/.stim/machine/<provider>/`, which ignores `STIM_HOME` like the EAS
   ledger and keeps its `STIM_TEST_GUARD_REAL_EAS_ROOT` guard, and the
   workspace record `{ provider, platform, handle, startedAt }`. A record with
   no `provider` is `eas`, so existing state reads the same.
3. If either write fails, the CLI calls `release(handle, { reason: 'abandon' })`
   and keeps the claim when that fails too, as `ensureRemoteBootOwned` does.
4. `stop`, `worktree remove` and `gc` call `release` only for recorded
   handles, drop the record only on a verified release, and keep it
   otherwise. `gc --delete` releases a handle only when the machine claim has
   it and no workspace records it; `inventory` entries with no claim are
   reported, never released.

Metro: the CLI passes `launch` a `MetroEndpoint`, which is a device-side
origin plus whether it was gated. A provider with `metroBridge` supplies it.
Otherwise the CLI gets a public origin through the transports
(`expose({ purpose: 'metro' })`, phase 5 of the transports spec; until then
`engine/metro-reach.ts`) and gates it as today. Launch status semantics do not
change: `true` only from bundle evidence on this workspace's Metro.

## Commands

`stim ios` and `stim android` get one remote path:

```text
placement -> describe (build target) -> build -> reuse or acquire -> record
-> Metro endpoint -> install -> launch -> agentDriver -> logs, view
```

`acquire` stays after the build, because an agent-device daemon exits five
minutes after its last request (#1212) and Argent Cloud releases an idle
machine after 15. The local path keeps its dep seam and phase order.

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
  today. Paired Macs are the `paired` provider's `capacity` probes, one per
  `remote.machines` entry.
- A provider whose `billing` is not `none` is only a fallback, used when this
  machine is at its cap and no free member admits the run. The fallback list
  is `remote.easFallback` in phase 1. A list setting naming providers in order
  replaces it later; that rename is a settings contract change and needs its
  own decision.
- A provider without `capacity` is never placed automatically (`proxy`).
- `--plan` reports a provider without a probe as unknown, as it does for EAS
  now (`device-host/plan-placement.ts:66-70`).

## Settings

- `ios.remote` / `android.remote` keep their values and scopes: `local`,
  `auto`, a provider id, or a paired machine name. `<provider>:<target>` is
  also accepted, the transports spec's prefix convention, so
  `paired:studio` names a Mac whose name collides with a provider id.
  Adding a provider id reserves that bare word; `doctor` reports a
  `remote.machines` entry that a new id shadows. The prefix form arrives in
  phase 2, with the `paired` provider.
- Provider ids are a closed choice of first-party names, like
  `hosting.agentDriver`, so validation and the JSON Schema keep rejecting
  typos.
- `remote.providers.<id>` holds provider options, machine scope only, with
  each `optionsSchema` joined into `settings.schema.json`. Credentials never
  live in settings: they stay in the provider's own tool or environment
  (eas-cli login, `AGENT_DEVICE_DAEMON_*`, `SIM_REMOTE_API_KEY`). The key
  arrives with the first provider that has an `optionsSchema`; `eas` and
  `proxy` have none.

Scope follows from that. A committed setting can choose a provider, which is
what `ios.remote: eas` does today, but cannot point one at an endpoint or
supply a key, so a cloned repository cannot send a build to a device the
user did not set up. Provider code resolves from Stim's own dependencies,
never from the project, as drivers and transports do: a provider makes
billing and teardown decisions, which a project-supplied module should not.

## Packaging

`stim` depends on every first-party provider package and imports one only
when a run selects it. `proxy` and `eas` are two packages, because a module
has one `id` and only `eas` needs eas-cli; the agent-device daemon client
(today `engine/agent-device.ts` and `remoteDeviceDeps`) lives in
`@stim-cli/device-provider-proxy` and the eas package depends on it. Each new
package needs npm to accept its first publish from the release workflow
before the first release that includes it.

## Paired Macs

`paired` implements every capability: `capacity` is `device-host.offer`,
`acquire` is `device-host.reserve`, `reuse` is `device-host.attach`,
`release` is `device-host.stop`, `parking` is the server's own, `metroBridge`
is the tailnet gateway, `logs` is `device-host.logs.query`, `view` is the
frame stream, and `agentDriver` is the host's `hosting.agentDriver` grant.

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
and its only duty is to record it and release it. Phase 2 folds
`finishHostedIosRun` and `finishHostedAndroidRun` into the common path.

## Devices Stim does not own

A third-party provider cannot promise Stim's device ledger on its side, so
Stim's ownership rule applies to the handle instead of the device: Stim
creates, reuses and releases only handles it acquired and recorded, and never
one it found.

| Provider     | `owns`    | What Stim owns                                                                                    |
| ------------ | --------- | ------------------------------------------------------------------------------------------------- |
| eas          | `device`  | the session it created, named `stim-<label>`; ending it ends the device                           |
| argent-cloud | `lease`   | the machine reservation it made under its own `SIM_REMOTE_SESSION`; never one reached by `attach` |
| proxy        | `nothing` | nothing; `release` only disconnects; from phase 2 the device record stops saying `owned: true`    |
| paired       | `lease`   | the session id; the host owns the device                                                          |

A provider promises: `acquire` creates a new lease and returns its id before
anything else can use it; `release` touches only that id and reports whether
it verified the result; a name marker such as `stim-<label>` is used where
the service has names, but never proves ownership, as with local devices.
A provider cannot promise exclusive use when the service shares the lease
(Argent machines are shared by a team, and releasing one erases every
simulator on it), so `describe` states it and placement treats it as busy.

## Argent Cloud

Status: planned. Public facts, from the Argent repository's
`packages/docs/docs/cloud` (software-mansion/argent `d24e2f1`, 2026-10-13) and
argent.swmansion.com/cloud:

- Hosted iOS simulators only, on Macs assigned to one customer; no Android or
  physical devices. $299 per month per runner of up to 6 parallel simulators,
  with no hourly billing.
- Agents connect through `sim-remote`, published only as binaries for macOS
  and Linux (software-mansion/sim-remote-releases, v1.0.0; no source or
  license found). It
  authenticates with `SIM_REMOTE_API_KEY` (or `--api-key`) against
  `SIM_ROUTER_URL` and keeps the session token in a local daemon's memory.
- `login` / `acquire` reserve a machine (waiting up to 1800 s, `--no-wait`),
  `release` returns it, `logout` and `daemon stop` end the session, `attach`
  and `list-machines` share machines. `SIM_REMOTE_SESSION=<name>` runs one
  daemon per name.
- Limits: idle release after 15 minutes (`SIM_REMOTE_IDLE_TIMEOUT_SECS`, server
  16), `keepalive`, 24 hours per machine and per token, 1 GiB per upload.
  Returning a machine erases every simulator and rebuilds the volume.
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

Mapping: `describe` from static facts and `list devices`; `acquire` is
`login` under `SIM_REMOTE_SESSION=stim-<workspace id>`, then a Stim-created
`stim-<label>` simulator; `reuse` checks that the named session still holds
the recorded machine; `release` is `logout` for that session only; `install`
and `launch` are `simctl install` and `simctl openurl` with Stim's dev-client
link; `metroBridge` is `reverse start` with the device origin
`http://localhost:<port>`; `logs` would poll `sim-remote logs`; `billing` is
`reserved`. `simctl` argument lists are verified against `sim-remote simctl`
once (invariant 9).

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
- Which agent driver? agent-device has no path to these simulators. Argent's
  tool-server sees them, but starting it on a Mac also injects its libraries
  into every booted local simulator (see the agent-drivers spec), so Stim
  would only hand the session name to an Argent the user runs.
- How is the video stream exposed, for `view`?
- Where is `sim-remote`'s source, and under what license is it distributed?
- Android, and whether a customer can run its own build cache next to the
  simulators.

## Phases

1. Add `@stim-cli/device-provider`, and move `proxy` and `eas` into their
   packages behind it, with `ios.ts` and `android.ts` calling the contract
   instead of `remoteIosDeps` / `remoteAndroidDeps`. No behavior change.
   Check: the existing `device-remote`, `eas-simulator`, `eas-fallback`, ios,
   android, stop, reclaim and gc EAS-session tests pass unchanged except for
   import paths; the contract kit passes for both; settings and guide
   contract tests are unchanged; `pnpm run knip` finds the old modules gone.
2. Add `@stim-cli/device-provider-paired` and fold the hosted iOS and Android
   branches into the common path; placement asks providers for `capacity`; the proxy device record stops saying `owned: true`.
   Check: the hosted client, placement, plan and server device-host tests
   pass; a field test against a paired Mac (debug and release, park and
   adopt, stop) per `docs/field-test-protocol.md`.
3. Add `@stim-cli/device-provider-argent-cloud` once the open questions above
   have answers. Check: the contract kit with a fake `sim-remote`, and one
   field run of install, launch with Metro, and release against a real
   machine.
