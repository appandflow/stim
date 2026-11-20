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
`remote.buildPoolDisabled`. A fresh build needs a free slot and, when the worker
reports its load, load below `server.maxLoadPerCore`. Use the client's limit
when the worker does not report a limit. In `auto`, a worker with unknown load
can take a build when local is disabled or every local slot is busy.
A matching completed artifact ranks before fresh build offers and skips
build capacity checks. The workers that can take a fresh build rank by what
they hold for it: first one whose area for this checkout completed a build of
this project and platform, then one with this checkout's dependency install
reusable or another checkout of the project built there, then the rest;
`remote.machines` order breaks ties. A warm worker with no free slot or with
its load at or above its limit is skipped like a cold one, and no build waits
for a busy warm worker. An explicit machine selects only that worker and
bypasses the automatic load filter. `auto` and `remote` fall back after an offload
failure only while local placement is enabled. `remote-only` and named
placement refuse when remote placement fails. No failure path writes the cache.

Explicit selection fixes where a build may run. Automatic selection can
keep development moving when workers are busy or unreachable. An existing
exact artifact saves a build, so it ranks ahead of a cold offer. A worker's
caches (the Stim home with DerivedData, the compilation cache and ccache, the
Gradle home, `node_modules` and Pods) live in its area for one client checkout,
and the client's pnpm store, CocoaPods and SwiftPM caches and uploaded blobs are
shared by that client's areas, so a worker that built the checkout or the
project rebuilds faster than a cold one with the same free slot.

The worker records each successful build's platform and project id (a hash of
the client's canonical git common directory and the app's path in the
repository, so every worktree of a repository, bare or not, shares it) in
`built.json` in the area, and answers `build.offer` from it. An offer from an
area whose exclusive claim another build holds declines a fresh build there,
which `build.start` would refuse, while an exact artifact is still served. The record goes
with the area when stim-server evicts it, is deleted when the area's home is
replaced for another schema, and is deleted when a build fails on a corrupt
compilation cache, which empties that cache. The worker's own maintenance
passes do not reach an area: discovery skips `server.workerRoot`, and the
compilation-cache and Cargo-target caps act on the worker's home and on
discovered checkouts. A native Xcode or Gradle build on the worker runs the
build headroom ladder (LLP 0006) in its area's home when the volume is short,
and that ladder can empty the home's shared caches, such as the Swift
compilation cache, while it keeps the build's own workspace. That trim, and any
other that empties part of an area, leaves the record in place: the worker
still reports the area warm, and the next build there is slower, never wrong,
since the build is fingerprint-checked.

This ordering supersedes #4321's strict `remote.machines` order for builds;
devices and macOS app hosts keep that order.

Recorded in [#5960](https://github.com/appandflow/stim/issues/5960):

Maintainer decision: "can machines have project afinity so it strongly prefers them since they will very likely have cache for that project or machines be able to advert what cache they have", 2026-11-19

The project-level rank, the rule that warmth never overrides the slot and load
gates, and no waiting for a busy warm worker were chosen by the coordinating
session for #5960, not by the maintainer.
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
declares that the client's environment, `.env.local` or `.env` sets. Its worker needs Exact's own Bun, Rust
and exact2 for the app's pins, at `~/.exact/exact2/<commit>` or in a folder named like the client's exact2
checkout, reports what it lacks in the offer with commands that fetch the commit from the client's remote, and builds
an app at the repository root in a checkout folder named like the client's; it shares the worker
user's `~/.cargo` and `~/.cache/exact` across clients. The app's relative path to exact2, which its Cargo
manifests use, holds a checkout of the pinned commit inside the build area that shares that checkout's objects (`git
clone --shared`) with a copy of its `node_modules`, never outside the area, in the app, or on one of the area's own entries, and replaced only when the
worker made it; a repository-root app's checkout sits as many folders below the area as that path climbs, and an app in
a subdirectory whose exact2 sits more than one folder above its repository builds on the client.

For an app that declares native modules, the worker creates a simulator in the build's own Stim home, boots it
through device boot admission, passes it as `EXACT_SIM`, and deletes it through centralized teardown when the build
ends or the job is stopped (a stopped job waits for a creation in progress, LLP 0013); every offloaded build starts by deleting any simulator that home's ledger still
lists, before it can reuse a retained artifact, and
stim-server neither evicts an area nor removes a client's areas while an area's home ledger lists a device.

Exact can run an app on a simulator during the build to resolve native modules, and without `EXACT_SIM` it takes any
booted simulator or boots one itself. An offload has no access to the client's owned simulator, and a simulator kept
in a build area's home would outlive that home when the area is evicted. Exact names each compiler input by its place
under the exact2 directory it runs from, which Bun resolves through links while Cargo reports the linked path, so a link
at the app's path fails the build. [LLP 0014](./0014-native-builds.decision.md#use-fixed-invocations).

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

## Node versions of client and worker

A React Native or Expo worker evaluates the fingerprint with the project's
pinned Node, or else the Node running its Stim, as the client does, and a
different Node major.minor does not refuse the build. The worker still refuses
with `fingerprint-runtime` when it cannot identify its runtime or when its
evaluator shims or the project packages that evaluation loads differ from the
client's. The fingerprint comparison is the gate: the worker builds and stores
an artifact only under a fingerprint it recomputed equal to the client's. When
the fingerprints differ and the Node versions differ, the `fingerprint-mismatch`
refusal names both; it calls Node the likely cause only when every differing
source is a `config` or `autolinking` row, which Stim produces by running project
JavaScript, and pod install or prebuild rewrote no synced file, else it notes
the versions without blaming them. The worker does not look for an installed
Node matching the client's.

Recorded in [#5812](https://github.com/appandflow/stim/issues/5812):

Maintainer decision: "lets do 2 and 3", 2026-11-16

Maintainer decision: "is it expensive to do 2? If not do it, if it is lets just skip and wee'll just rely on fingerprint check", 2026-11-16

Maintainer decision: "On figerprint mismatch could we know node version is the cause of mismatch and just warn there", 2026-11-16

Option 2, the worker running an installed Node of the client's version for an
unpinned project, was skipped as not cheap: the evaluator, the dependency
install marker and the build's own `node` invocations each choose their Node
separately. The fingerprint does not hash the Node version, so two machines on
different Node versions can compute the same one (an Expo SDK 58 app did under
Node 22.22 and 24.22), and refusing them up front sent such builds back to the
client. The worker's first evaluation reports a differing source through the
same `fingerprint-mismatch` refusal, with the sources named. A Node difference that leaves the fingerprint equal but changes the built
app is not caught; the build's own project JavaScript (prebuild's config
plugins, autolinking in pod install and Gradle, Xcode's script phases) runs on
the `node` first on the worker's `PATH`, which the old check did not constrain
either. A project that pins its Node gets that Node on both machines.

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
claims for manual inspection and recovery, and the refusal names one command
that removes the fingerprint work directory and every retained claim. A worker
stopped with SIGTERM (a cancel, a closed connection or the build timeout)
aborts its fingerprint evaluation, stops its Gradle daemons or Exact simulator,
and reports a settled `cancelled` result only once every
process group it started outside its own through exec is gone; the host then
releases the claims after the worker's own group has exited, as for a finished
build. A worker that does not report within the kill grace period is killed and
keeps its claims. Off Windows, a stopped build's host also follows what the build
tool started in other process groups (Xcode runs its build service and each
script phase in a group of its own): before it first signals the worker's group,
and at each check after, it walks the process tree down from the group's members,
while the group is not yet seen empty, and from the processes it recorded whose
identity still matches, records each one outside the group by its identity once a
second listing confirms it, signals a recorded process only while that identity
still matches, and releases the claims only once the group and every recorded
process are gone. Once the group reads empty its id is no longer signalled or
walked from. A process listing or identity it cannot read, a captured process that
left the tree before it was confirmed, or anything still running a kill grace
period after SIGKILL ends the build `cleanup-unresolved` with its claims kept; the
outcome is recorded either way. A process whose parent exited before a walk saw
it is not seen: one that left the tree before the first walk, or one started
after a walk whose parent exits before the next. A daemon the build started that
would have outlived it is stopped too.
This SIGTERM rule and the tree walk were chosen by the implementers of #5792, not
by the maintainer. stim-server evicts areas of approved
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
builds only; setup there approves `build` and refuses `device-host`, Linux setup
also approves `test` and Windows setup refuses it (LLP 0020), and off macOS
stim-server refuses device-host requests and grants. A client approved for `build`,
`device-host` or `test` can update this machine's engine over an authenticated network connection
(`engine.update`, which runs this build's `engine-select` as an unattended
promotion), and no other connection can. An exact npm release needs no setting; a client's own
packages are taken only while `server.acceptClientBuilds` is `true`, its
default being `false`.

A service installed before the engine existed moves onto the shim when its server boots on a Stim that has this
code. On Linux that boot rewrites the unit's `ExecStart=`, runs `systemctl --user daemon-reload`, and reads
`systemctl show` back to confirm that systemd loaded the shim (a failed reload is retried at each later boot and logged
with the restart command). The net thread then asks stimd to exit once idle: no command, no pinned work (build slots,
hosted native work, cleanups, running Metro, log streams), the same condition as an engine switch. systemd's
`Restart=always` starts it again about 30 seconds later from the loaded shim definition. A pure npm-copy service
therefore needs one automatic restart after its first boot on this code; until a restart reaches code that has the
rewrite (`stim service install`, `systemctl --user restart`, a crash or a reboot) it stays on its build. When the
engine later flips under a shim service, the unit's job starts the new build, as described below. A unit with a drop-in that sets
`ExecStart=`, or a multi-line `ExecStart=`, is not rewritten; the server logs it and `stim doctor` reports the
drop-in. A launchd job re-reads its plist only at bootstrap, so the macOS rewrite does not take effect on an exit and
restart; it needs a `launchctl bootout` and `bootstrap`, and the server requests no restart there (#5608). The server and stimd never reload a LaunchAgent or change its `ProcessType`. `stim setup`, `stim service status` and `stim doctor` report a managed unit whose plist `ProgramArguments` or `ProcessType`, or the arguments launchd loaded, differ from what `stim service install` writes now, and print `stim service install` as the remedy, which is the only path for a unit with an older `ProcessType`. `stim setup` still reinstalls a unit whose script or options differ, as install does. Maintainer decision: "do the small fix for 2.0", 2026-11-19 ([#5859](https://github.com/appandflow/stim/issues/5859#issuecomment-7024979961)). A Windows task runs the build it was installed with, since the engine writes no Windows `stimd` entry (#5602). Connected phones and Desktop are disconnected by the one idle restart.

An engine switch under a launchd or systemd unit hands over through the unit's job, so the stimd that serves the unit's port stays inside it and stopping or restarting the unit stops or restarts that stimd (#6003). The job ends up the owner of a home whose unit follows the engine: its job runs the engine's `bin/stimd` shim and, on Linux, systemd has loaded the unit with `KillMode=process`. A stimd the job runs (its `XPC_SERVICE_NAME` or `STIM_SERVICE_LABEL` names a unit install wrote for its port, and it has no `--unit-successor`), whose unit follows the engine, starts no successor at a switch once the shim names the new build, or at a crash-loop rollback; while the shim still names an older build it hands over to a successor as before. At a switch it logs `successor_job`, shuts down and exits, and KeepAlive or `Restart=always` runs the shim again, which starts the new build inside the job. launchd starts a job that ran longer than its 30 s `ThrottleInterval` again at once; systemd waits `RestartSec`, 30 s. Nothing reserves the home during that restart: a command, Stim Desktop or `stim ci` that needs a stimd then starts one, as on any home. A command of the new build that the outgoing job's stimd refused also starts one once that stimd is gone, because its refusal says the home goes to the job (`job: true`) and no successor will come, and `stim pair --port` asks that stimd for the net thread on the port it pairs for. When the job's process finds the home held, it asks the holder for the service's net thread naming its unit, as LLP 0012 describes, and a holder that is neither the job's stimd nor attached to a command records that the service takes the home back when it accepts the ask, or when it refuses it only because its own net thread serves other options that Stim Desktop did not ask for: it exits once no command runs, nothing is pinned and its net thread is not share-only, the condition a service restart uses, and starts no successor. The job's process waits on that connection; when the holder closes it, the job's process waits for the holder's claim to be released, within a shutdown's deadline, and runs the stimd itself, inside the job, or asks the stimd that took the home first in the same way; when the engine selected another build meanwhile it exits instead, and the service manager starts the selected build through the shim. A job's process that the holder refused exits as before, and its restart finds the home free once the holder is idle. A stimd removes the `run/job-restart.json` an earlier 2.0 prerelease left when it left the home to its job (compat C34, ends 2.1.0). The maintainer chose this shape in the coordinating session for #6025 on 2026-11-20, picking "Service wins later" when asked whether commands should wait on the service manager or start stimd as today with the job taking the home back once that stimd is idle; the issue does not record the choice. Remaining risks: until it is idle, a command's stimd serves the unit's port outside the job, so stopping or restarting the unit in that window leaves that stimd running; a holder whose net thread Stim Desktop started on other options refuses the service's ask and is not replaced, the open decision of #5095; and a build older than this rule never asks to be replaced. A unit install writes on Linux sets `KillMode=process`, as the transient successor did, so the stimd's exit at a switch does not kill the Metro servers, tunnels and adb server it leaves for the next stimd to adopt; a unit written before this keeps systemd's default, which would kill them and the emulators hosted sessions booted, so a stimd whose unit systemd has not loaded with `KillMode=process`, including one the server moved onto the shim, keeps the successor handover until `stim service install` runs again. A stimd reads the mode systemd has loaded (`systemctl --user show -p KillMode --value`), not the unit file, so a drop-in that sets another mode, or a file systemd has not reloaded, also keeps the successor handover. Stim does not add the line to an existing unit; `stim service status`, `stim doctor` (`server-service-stale`) and `stim setup` name the install, with the unit's own options, for a unit install wrote whose file sets no `KillMode=process` (#5873). Maintainer decision: "I agree lets do this and ur recommendations from prev messages, also lets do the changes now that u flagged as after 2.0 id rather delay than ship what we have", 2026-11-20 ([#6025](https://github.com/appandflow/stim/issues/6025)), which takes the recommendation to read the loaded mode and print the reinstall remedy, with no boot-time migration. The same setting leaves those children running when the unit is stopped, restarted or uninstalled, as a LaunchAgent does with the detached children of its stimd. On Linux a switch now leaves the port unserved for systemd's 30 s and the boot, where a transient successor bound within 10 s; connected phones, Desktop and offload clients reconnect after it. A unit that keeps the successor handover, by its first switch onto this build or a Linux unit without `KillMode=process`, still has its main process as a waiter after the switch, so stopping or restarting the unit does not stop the stimd that serves its port. A stimd that a command started before the unit's process, or that an earlier build started outside the job with `--unit-successor <label>`, leaves the home the same way once it is idle: the job's process names the label in its `net.ensure` ask only when its job runs the shim. A stimd that no shim unit's job runs keeps the handover to a successor it starts: `stim serve`, including a shim-less unit's `stim serve --service`, and the stimd of Stim Desktop or of a command. Chosen by the implementing lane for #6003, not by the maintainer.

The unit's process waits the same way whenever its home is already held when it starts, by a stimd that Desktop or a command started first. `stim service status` names the process that listens on the unit's port, whether it is the live stimd of the unit's Stim home (by that home's stimd claim and its process identity), and whether the job runs it (the job's process, or its direct child: Stim Host spawns the shim, which execs node); `--json` adds this as `listener`. Before stopping a job that runs a process, `stim service install` looks for the successor that serves the unit's port from outside the job, and counts a stimd only when all of these hold: the unit's home's live exclusive stimd claim names it with the same process identity; the claim's `serviceUnit` names the label being installed. A stimd records a unit label there only with positive provenance: it runs `__stimd --service` without `--carried` (or the shim-less unit's `stim serve --service`) and the job's environment names a unit that `stim service install` wrote for its port (launchd sets `XPC_SERVICE_NAME` to the job's label, and a unit install wrote sets `STIM_SERVICE_LABEL`), and it records that label; or it was started with `--unit-successor <label>`, which a stimd holding a label passes to the successor it hands the home to. The mark guards against stopping a stimd by accident, not against a same-user process that forges it with these arguments or variables, which could signal stimd directly anyway, so it is not checked against the service manager. A plain `stim serve`, a stimd that Desktop or a command started, and a successor an older build started with `--service` alone carry no mark. The stimd must also not be attached to a command or be this process, must listen on the unit's port, and must not be the job's process, with a readable parent that is not the job's process, so it is not the job's direct child. After the job stops, install reads the claim, its identity and the listener again; when `run/stimd.json` still names that stimd it sends one SIGTERM, the signal stopping the job sends to a stimd inside it, and when the record is gone the stimd is already shutting down, so it is not signalled again, since a second signal forces its exit and records an abnormal boot. Either way install waits for it to exit within the same 45 s. Nothing is signalled on Windows, where Stim writes no engine shim, when no job is loaded, or when the job runs no process (launchd between restarts, systemd `activating (auto-restart)`). When the stimd outside the job passes every check but its claim names no unit or another label, because Stim Desktop, `stim serve`, an older build or another unit started it, install refuses before unloading the job and before its rollback path, leaves the service as it was, and names the home, the pid, `kill <pid>` and running the same `stim service install` command again, not a different command, since an install with only `--label` takes the default port and options. Stopping that stimd also stops what Desktop or that command is using. Any other listener install cannot attribute this way is left running, and install waits out the port and fails as before. `stim service uninstall` signals nothing: it keeps #5756's refusal while the home's verified stimd still listens. The stopped successor is the stimd Desktop and commands of that home share, as when it runs inside the job. Chosen by the implementing lane and the coordinating session for #5858, not by the maintainer. On Windows no stimd is marked.

A per-user service keeps worker ownership with the approving user. A version-neutral launchd or systemd shim lets the engine switch after work drains without replacing service setup or pairings. [Engine integration](https://github.com/appandflow/stim/pull/5380).

## Code

- [Worker approval](../packages/server/src/setup.ts), [job launch](../packages/server/src/offload-jobs.ts), and [engine update authorization](../packages/server/src/handlers/engine.ts).
- [Build placement](../packages/stim-cli/src/offload/client.ts), [signing input selection](../packages/stim-cli/src/offload/signing-files.ts), and [compatibility version](../packages/stim-cli/src/engine/toolchain.ts).
- [Offload job host](../packages/stim-cli/src/job/offload/host.ts) and [worker service](../packages/server/src/service.ts).
