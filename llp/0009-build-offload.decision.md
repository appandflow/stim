# LLP 0009: Build offload and worker services

**Type:** Decision
**Status:** Active
**Systems:** Builds, Server, Engine, Signing
**Author:** Codex
**Date:** 2026-11-12
**Related:** LLP 0007, LLP 0008, LLP 0010, LLP 0014

## Worker-side approval

stim-server's `build` capability lets another approved network machine run its project code on this machine to build. The requesting machine
makes a setup ticket (Stim Desktop's Add Machine flow, or `stim remote add`
or `stim doctor --fix`, which print the command), and a person approves it by running
`stim setup` on the worker with the ticket in `STIM_SETUP_TICKET`.
Running setup is the worker-side approval: a person on the
worker approves the key holding one ticket, once per capability, until one
expiry, with a per-grant Y/n confirmation (Enter approves) in
a terminal (`--yes` otherwise). Stim Desktop on the worker is the other
approver: the person pastes the setup command there, and the server Desktop
started runs the same setup in process (`desktop.setup.subscribe`), asking
each grant through `desktop.setup.answer` instead of the terminal, and
refuses rather than install or change a service, Stim Host or a route. Only
the connection that proved Desktop's private bootstrap key may call either;
another machine, a paired client, an SSH session and any other local client
get `forbidden` on those methods. The terminal command, `--yes` included,
approves as before. An SSH-driven run is not offered. Setup
never enables Funnel or changes TCC. There is no pairing code for build, and
`stim pairings grant` never grants it.
It never comes with `read` or `control`. Build clients live in
`server/build-clients.json`, apart from `devices.json`. The client names its
remote machines in `remote.machines` and pins each one's stim-server key in
`build-machines.json`; a worker that cannot prove that key is refused.

Running a project build grants the client code execution on the worker. A worker-side approval makes that grant explicit. Viewing another server’s workspaces and placing builds on a worker are different relationships, even when both appear in the same Connections view. A setup ticket reaches the worker through the person approving it, so an unknown key cannot add pending requests by dialing the server. [Capability split](https://github.com/appandflow/stim/pull/1809), [Worker-side Desktop approval](https://github.com/appandflow/stim/pull/5120).

## Placement and fallback

`remote.build` places iOS simulator, Android emulator and macOS SwiftPM Debug
builds. Use `local`, `auto`, `remote`, `remote-only` or one machine.
`auto` prefers the eligible local machine while it has capacity. `remote`
prefers workers. Automatic placement skips members in
`remote.buildPoolDisabled` and considers the remaining workers in
`remote.machines` order. A fresh build needs a free slot and, when the worker
reports its load, load below `server.maxLoadPerCore`. Use the client's limit
when the worker does not report a limit. In `auto`, a worker with unknown load
can take a build when local is disabled or every local slot is busy.
A matching completed artifact ranks before fresh build offers and skips
build capacity checks. An explicit machine selects only that worker and
bypasses the automatic load filter. `auto` and `remote` fall back after an offload
failure only while local placement is enabled. `remote-only` and named
placement refuse when remote placement fails. No failure path writes the cache.

Explicit selection fixes where a build may run. Automatic selection can
keep development moving when workers are busy or unreachable. An existing
exact artifact saves a build, so it ranks ahead of a cold offer.
[Placement rules](https://github.com/appandflow/stim/pull/4331),
[Remote artifact reuse](https://github.com/appandflow/stim/pull/3594).

## Signing stays with the client

An Android offload leaves keystores other than
`debug.keystore`, and `keystore.properties`, out of the fingerprint and, unless a
debug build's Gradle script names one, out of the sync
(`packages/stim-cli/src/offload/signing-files.ts`); an iOS offload does the same for
`*.p8`, `*.p12`, `*.mobileprovision` and `*.provisionprofile` that no Xcode build file names. A release variant's worker
builds any other signing config unsigned
(`packages/stim-cli/shim/android-worker-release.gradle`) and the client signs it
with its `zipalign` then `apksigner` path, or refuses.

A simulator build does not need store signing credentials. Syncing every ignored fingerprint input once included an App Store Connect key. The platform filters avoid transferring credentials and keep the client and worker fingerprint inputs consistent. [Android signing exclusions](https://github.com/appandflow/stim/pull/5211), [iOS signing exclusions](https://github.com/appandflow/stim/pull/5224).

## Exact builds

An offloaded Exact
build is keyed by the synced manifest's digest, installed from the fetched
app and never cached; it carries the values of the settings `app.json` `env`
declares that the client's environment, `.env.local` or `.env` sets, and only for an
app that declares no native modules. Its worker needs Exact's own Bun, Rust
and exact2 for the app's pins, reports what it lacks in the offer, and builds
an app at the repository root in a checkout folder named like the client's; it shares the worker
user's `~/.cargo` and `~/.cache/exact` across clients.

Exact can run an app on a simulator during the build to resolve native modules.
An offload has no access to the client's owned simulator. [LLP 0014](./0014-native-builds.decision.md#use-fixed-invocations).

## Run the client build

An offloaded build runs
the client's exact Stim build on the worker: the worker's stimd answers
`job.start` by running that build's `dist/cli.mjs __job offload-build` (or
`offload-probe` for an offer) from its engine store with a Node that meets the
build's `engines`, fetching a published release from npm, or taking a build
from a checkout or `stim engine use <path>`, which the client packs, only while
`server.acceptClientBuilds` is `true`. stimd passes each Noise message of the
connection to the job as one frame (a 4-byte big-endian length, then the
message's type byte and body) and each frame the job writes back as one
message, and parses neither. A closed connection ends the job's stdin. An
unexpected disconnect leaves it open for `job.start {attach}` during the
detach grace period. An ordinary client cancellation closes its connection.
On server-side stop, shutdown or revocation, the server ends stdin and sends
SIGTERM off Windows, with a timed hard-kill fallback. On Windows, EOF gives
the job a chance to cancel its build because Node implements SIGTERM there
with `TerminateProcess`. This spawn and framing are frozen.

Executing the client’s version keeps a worker update from changing the build recipe or forcing an otherwise eligible run back to the client. The resident server carries frames across versions while the job interprets its own protocol. [Exact client jobs](https://github.com/appandflow/stim/pull/5373), [Engine integration](https://github.com/appandflow/stim/pull/5380).

## Artifact compatibility

Two machines reuse each other's completed
React Native and SwiftPM artifacts when their builds report the same
`STIM_BUILD_COMPAT` (`packages/stim-cli/src/engine/toolchain.ts`, in the
`stim` package because `@stim-cli/core` is a ranged dependency). Bump it when a machine with the same value but
the other version of a file listed in `scripts/build-compat.json` would
build a different artifact or read a build or artifact message
differently; a fix that makes a failing worker build succeed, or a field
negotiated by a `hello` feature, needs no bump. `pnpm run lint` fails until
`node scripts/build-compat.mjs --update` records the change, and the
reviewer checks that record against this rule. The compatibility version
never enters the local cache key.

A client job can run on a different engine, but a retained artifact still needs proof that its producer would build and describe the same artifact. Keeping the version out of the local key preserves locally valid cache entries when a wire contract changes. [Wire versions](https://github.com/appandflow/stim/pull/5327).

## Repository ownership and cleanup

A hosted macOS session takes a build the same Mac ran for
it, instead of an upload, only when the build client and the device-host
client are approved for the same client key, and only bytes matching the
client's verified bundle manifest. The worker builds each client and
repository in its own area and Stim home under `server.workerRoot`, guarded by an ownership
claim. Non-Android claims follow the worker process group. Android claims
stay child-pending because Gradle daemons leave that group; cancellation
releases them only after this repository's verified daemon identities exit.
Unknown cleanup or a server crash retains unresolved repository and build-slot
claims for manual inspection and recovery. stim-server evicts areas of approved
clients unused for longer than `server.workerAreaMaxAgeDays` and, near the disk
floor, the least recently used not used in the last 3 hours, which under the
floor also go; it keeps each client's most recently used area and retains one
with a live build, unfetched output, a running Gradle daemon or a held or
unresolved claim. Under the area's claim it creates an empty record, whose name
alone carries the repository and id because a client's build can write there,
renames the area out of `repos/` and moves aside the short directories whose
`.owner` names the area, then deletes outside the claim, the record last, so a
later pass finishes a failed or interrupted deletion. Windows has no process
groups:
cancel stops the worker tree with `taskkill /T`; each checkout and repository's
Gradle home live in private `windowsShortDir`s under `<SystemDrive>\sw`,
because the NDK's ninja cannot open longer paths. The repository's daemon
follows Gradle's idle policy after an Android build. Each build clears only
the old generated idle-timeout override in its selected owned Gradle home.
Cancellation drains only that repository; whole-client revocation and low
memory retain their client-scoped cleanup. Low-memory sweeps wait until no
offloaded build is running. Gradle stops a daemon
whose Gradle home is deleted.

Cancelling a build used to stop another repository’s Gradle daemon when both shared a Gradle home. Repository-local identities and claims let the sibling build continue. The eviction record has a name-only identity because the build can write inside the directory being evicted. [Gradle cancellation](https://github.com/appandflow/stim/pull/4725), [Area eviction](https://github.com/appandflow/stim/pull/5207).

## Service and engine updates

`stim service` installs,
reports and removes the worker's per-user service, a LaunchAgent on macOS,
a systemd user unit on Linux or a scheduled task on Windows, whose action is
Stim's supervisor because Task Scheduler does not restart an exited process,
and, only when asked, a tailnet-only serve
route; it never enables Funnel, never runs sudo or elevates, and never touches pairings,
`$STIM_HOME/server` or settings. With the Stim engine installed, a launchd
or systemd unit names the engine's `bin/stimd` shim and follows the engine. `stim engine update`
and `stim engine rollback` move it through the engine store's drain and switch,
and a crash-looping build is rolled back to `previous` by its own next boot. A Linux or Windows worker takes Android
builds only; setup there approves `build` and refuses `device-host`, and off macOS
stim-server refuses device-host requests and grants. A client approved for `build` or
`device-host` can update this machine's engine over an authenticated network connection
(`engine.update`, which runs this build's `engine-select` as an unattended
promotion), and no other connection can. An exact npm release needs no setting; a client's own
packages are taken only while `server.acceptClientBuilds` is `true`, its
default being `false`.

A per-user service keeps worker ownership with the approving user. A version-neutral launchd or systemd shim lets the engine switch after work drains without replacing service setup or pairings. [Engine integration](https://github.com/appandflow/stim/pull/5380).

## Code

- [Worker approval](../packages/server/src/setup.ts), [job launch](../packages/server/src/offload-jobs.ts), and [engine update authorization](../packages/server/src/handlers/engine.ts).
- [Build placement](../packages/stim-cli/src/offload/client.ts), [signing input selection](../packages/stim-cli/src/offload/signing-files.ts), and [compatibility version](../packages/stim-cli/src/engine/toolchain.ts).
- [Offload job host](../packages/stim-cli/src/job/offload/host.ts) and [worker service](../packages/server/src/service.ts).
