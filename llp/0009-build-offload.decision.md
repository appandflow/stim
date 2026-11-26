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
area whose claim another build or a concurrent artifact query holds declines a
fresh build there, which `build.start` would refuse, while an exact artifact is
still served. An unresolved claim is left to `build.start`, whose refusal names
the claim and how to clear it. The record goes
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
Node matching the client's. Both machines take the pin from the app directory
or the nearest directory above it up to the repository root, where Metro and
the worker's dependency install find it, so a monorepo's root `.nvmrc` selects
the Node that evaluates as well as the one that installs
([#6459](https://github.com/appandflow/stim/issues/6459)).

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

A client records, in each workspace's state (`buildAreas`), every worker an offloaded build of that workspace
went to, with the area's name there, the checkout's canonical root and the device id of the volume that holds it,
before it syncs or fetches. Once that checkout is proven gone (`stim worktree remove` of a linked worktree, which `gc`
and maintenance also run, or the reclaim of a project whose folder is already gone), it asks each recorded worker, in
parallel and within 5 seconds, to drop that area with `build.area.drop`, a method of the `build` capability that names
only the area. Proven gone means the root is absent and its nearest existing ancestor is on the recorded device, so a
checkout on an unmounted volume, whose mount point then sits on its parent's volume, is never taken for removed; a
record without the device is not read. The client checks again just before it sends the request, and a connection
that opens after the deadline is closed unasked, since the area name hashes only the path and a checkout recreated
there would be the one dropped. The worker takes the client from the authenticated connection, so a client reaches
only its own areas. It accepts only a name that is exactly one of the client's area entries, never its claim set or
another spelling of it, and checks again after listing processes, so an area moved or a client removal started
meanwhile answers as such. It drops the area, its client's newest included, unless one of eviction's per-area retain
rules holds (a live build, unfetched output, a running Gradle daemon, a held or unresolved claim, a device its home
lists, or a process list it cannot read), with the same claim-guarded move aside, answers once the area is out of
`repos/`, and deletes it after. The planner's age, free-space and newest-area rules do not apply. It prunes the
client's unreferenced blobs only while another area of that client remains, so the next checkout of a
worktree-per-task client reuses them. Removal never waits longer or fails for it: a worker that is unreachable,
unpaired, refuses or answers late is skipped, as is one older than this method, which answers `forbidden` to a
build-only connection; that worker's `server.workerAreaMaxAgeDays` still applies. A worker that could not be reached
or did not answer in time is not asked again by the same process for 10 minutes, so a `gc` pass or a long-running
stimd that removes many worktrees waits for it once.

A worktree per task leaves one area per removed worktree on the worker, each 14 to 28 GB, for the full age limit.
A worker serving one agent machine held 670 GB of such areas at 94% disk while the least-recently-used floor never
triggered. The area name hashes the checkout's real path, which cannot be recomputed after the folder is gone, so
the client records it when it first uses a worker.

Recorded in [#6289](https://github.com/appandflow/stim/issues/6289):

Maintainer decision: "Yes, file it (Recommended)", 2026-11-24, choosing to file an issue "so a worker drops a client checkout's build area as soon as that worktree is removed (instead of waiting out the age limit)".

Maintainer decision: "can u file and implement too", 2026-11-24.

The method name, the record in workspace state, the 5-second deadline and 10-minute skip, dropping a client's
newest area, keeping its blobs when no area remains, and answering before the deletion finishes were chosen by the
implementer of #6289, not by the maintainer.

A revocation removes a client's folder under `server.workerRoot` only when a job of that client ran in the stimd that
sees it, so the registry records each build client id it drops (a revocation, or the record a fresh setup of the same
key replaces) in `server/removed-build-clients.json`, in the same transaction and before it rewrites
`build-clients.json`. A record file that cannot be read whole is left as it is and records nothing. Each eviction pass,
while stimd is ready, removes the folder of a recorded id that the approvals, read whole, do not name, through the same
removal as a revocation with the same retain reasons, each logged once until it changes. It acts on nothing when either
file cannot be read whole or an approval entry's id is not a registry id, and an approval entry this version cannot
read, or whose `capabilities` is not a list of names, names its id. A folder with no record stays whatever it is named
or holds, because a client's build writes there. Every removal of a whole client folder, a revocation's included, stops
the client's jobs and drops its kept bundles, then keeps the folder while the approvals cannot be read whole or still
name the id. An id leaves the record only after this process deleted that folder, never because the folder reads absent,
which an unmounted volume also shows: the folder is checked again, by device and inode, just before it is deleted, and
one that went away or changed meanwhile stays recorded. Folders orphaned before this rule, or by hand-editing the
registry, have no record and are not removed automatically.

A worker held 7 areas, 20 GB, of a client that `stim pairings` no longer listed a month after a revocation no running
stimd had served, while age eviction, which reads only approved clients, never reached them. Recorded in
[#6294](https://github.com/appandflow/stim/issues/6294); the rule follows the issue's fix idea, written by an agent,
and the recorded-removal design, its file and format were chosen by the implementer of #6294, not by the maintainer.

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

`stim remote update <machine>` picks the newest release on the worker's channel
whose peer is at least the client's, or, with `--to <version>`, exactly
that published release. Doctor and the `peer-too-old` refusal name
`--to` with the client's own version for a worker whose peer is too old:
the npm listing carries no peer per version, so a channel pick can land on a
release older than the worker, which refuses a downgrade, while the client's
own version, when published, always carries the client's peer; a client on an unpublished build gets a remedy naming a version npm does not list. An unpublished version, or
`--to` with `--channel`, refuses with `STIM_BAD_ARG` before the worker is
asked. The flag is `--to`, not `--version`, because `--version` anywhere
after a `remote` subcommand prints Stim's version. Maintainer decision: "yes do
it for 2.0", 2026-11-26 ([#6508](https://github.com/appandflow/stim/issues/6508));
the maintainer chose the name `--to` in the coordinating session on 2026-11-26,
which the issue does not record.

A service installed before the engine existed keeps running the build its unit names: neither the server nor stimd rewrites or reloads a unit at boot. `stim setup`, `stim service status` and `stim doctor` report a managed unit that does not run what `stim service install` writes now and print `stim service install` as the remedy, the only path onto the shim: a LaunchAgent whose plist `ProgramArguments` or `ProcessType`, or the arguments launchd loaded, differ (Maintainer decision for LaunchAgents: "do the small fix for 2.0", 2026-11-19, [#5859](https://github.com/appandflow/stim/issues/5859#issuecomment-7024979961)), and a systemd unit that names node while the engine store has the shim, or sets no `KillMode=process`. `stim setup` still reinstalls a unit whose script or options differ, as install does. Chosen by the lane for #6027, not by the maintainer: the boot rewrite this replaces could drop a key a user added to the plist and leave a staged file, and the stale finding already names the fix. A Windows task runs the build it was installed with, since the engine writes no Windows `stimd` entry (#5602).

An engine switch under a launchd or systemd unit hands over through the unit's job, so the stimd that serves the unit's port stays inside it and stopping or restarting the unit stops or restarts that stimd (#6003). The job ends up the owner of a home whose unit follows the engine: its job runs the engine's `bin/stimd` shim and, on Linux, systemd has loaded the unit with `KillMode=process`. A stimd the job runs (its `XPC_SERVICE_NAME` or `STIM_SERVICE_LABEL` names a unit install wrote for its port, and it has no `--unit-successor`), whose unit follows the engine, starts no successor at a switch once the shim names the new build, or at a crash-loop rollback; while the shim still names an older build it hands over to a successor as before. At a switch it logs `successor_job`, shuts down and exits, and KeepAlive or `Restart=always` runs the shim again, which starts the new build inside the job. launchd starts a job that ran longer than its 30 s `ThrottleInterval` again at once; systemd waits `RestartSec`, 30 s. Nothing reserves the home during that restart: a command, Stim Desktop or `stim ci` that needs a stimd then starts one, as on any home, and `stim share list` or `stop` reports saved live links as resuming when the service or the next command starts stimd, not that nothing is shared. A command of the new build that the outgoing job's stimd refused also starts one once that stimd is gone, because its refusal says the home goes to the job (`job: true`) and no successor will come, and `stim pair --port` asks that stimd for the net thread on the port it pairs for. When the job's process finds the home held, it asks the holder for the service's net thread naming its unit, as LLP 0012 describes, and a holder that is neither the job's stimd nor attached to a command records that the service takes the home back when it accepts the ask, or when it refuses it only because its own net thread serves other options that Stim Desktop did not ask for: it exits once no command runs, nothing is pinned, its net thread is not share-only, no offload is under way, from an accepted package upload through the job's exit, an artifact delivery included, no hosted device session is open and no workspace action such as a worktree warm runs in its net thread (the net thread reports how many of these are under way), and the job's process has run for launchd's 30 s `ThrottleInterval` since it started, which its ask carries (`startedAt`), so that launchd restarts it at once when it exits, starts no successor, and hands its device log streams over as at an engine switch, so the job's stimd resumes them under the same stream ids. The job's process serves through the holder until the holder closes the connection, then exits, and launchd or systemd starts it again, which takes the home. This costs the unit's restart delay: launchd starts a job that ran for its `ThrottleInterval` again at once, which is why the holder waits for it (a shorter run would leave the home empty for the rest of the interval, long enough for Stim Desktop's 10 s poll to start a stimd that the next job takes back again, in a loop), while systemd waits `RestartSec`, 30 s, during which a command that needs a stimd starts its own, which the job takes back the same way once it is idle. A job's process that the holder refused exits the same way. The maintainer chose this shape in the coordinating session for #6025 on 2026-11-20, picking "Service wins later" when asked whether commands should wait on the service manager or start stimd as today with the job taking the home back once that stimd is idle, and later in that session chose to exit and let the service manager restart the job rather than take the home back in place, and to drop the protections listed below as accepted risks; the issue does not record these choices. Remaining risks: until it is idle, a command's stimd serves the unit's port outside the job, so stopping or restarting the unit in that window leaves that stimd running; a holder whose net thread Stim Desktop started on other options refuses the service's ask and is not replaced, the open decision of #5095, but its successor after an engine switch is replaced, as is a stimd Stim Desktop started that has no net thread yet, each costing Desktop one reconnect; a `stim serve` the user runs in the foreground, or one that serves through an existing stimd, is taken back like a command's stimd, which ends it; a command that a stimd of an earlier 2.0 prerelease refused waits the usual 15 s for a successor once; and a build older than this rule never asks to be replaced. A unit install writes on Linux sets `KillMode=process`, as the transient successor did, so the stimd's exit at a switch does not kill the Metro servers, tunnels and adb server it leaves for the next stimd to adopt; a unit written before this keeps systemd's default, which would kill them and the emulators hosted sessions booted, so a stimd whose unit systemd has not loaded with `KillMode=process` keeps the successor handover until `stim service install` runs again. A stimd reads the mode systemd has loaded (`systemctl --user show -p KillMode --value`), not the unit file, so a drop-in that sets another mode, or a file systemd has not reloaded, also keeps the successor handover. Stim does not add the line to an existing unit; `stim service status`, `stim doctor` (`server-service-stale`) and `stim setup` name the install, with the unit's own options, for a unit install wrote whose file sets no `KillMode=process` (#5873). Maintainer decision: "I agree lets do this and ur recommendations from prev messages, also lets do the changes now that u flagged as after 2.0 id rather delay than ship what we have", 2026-11-20 ([#6025](https://github.com/appandflow/stim/issues/6025)), which takes the recommendation to read the loaded mode and print the reinstall remedy, with no boot-time migration. The same setting leaves those children running when the unit is stopped, restarted or uninstalled, as a LaunchAgent does with the detached children of its stimd. On Linux a switch now leaves the port unserved for systemd's 30 s and the boot, where a transient successor bound within 10 s; connected phones, Desktop and offload clients reconnect after it. A unit that keeps the successor handover, by its first switch onto this build or a Linux unit without `KillMode=process`, still has its main process as a waiter after the switch, so stopping or restarting the unit does not stop the stimd that serves its port. A stimd that a command started before the unit's process, or that an earlier build started outside the job with `--unit-successor <label>`, leaves the home the same way once it is idle: the job's process names the label in its `net.ensure` ask only when its job runs the shim. A stimd that no shim unit's job runs keeps the handover to a successor it starts: `stim serve`, including a shim-less unit's `stim serve --service`, and the stimd of Stim Desktop or of a command. Chosen by the implementing lane for #6003, not by the maintainer.

The unit's process waits the same way whenever its home is already held when it starts, by a stimd that Desktop or a command started first. `stim service status` names the process that listens on the unit's port, whether it is the live stimd of the unit's Stim home (by that home's stimd claim and its process identity), and whether the job runs it (the job's process, or its direct child: Stim Host spawns the shim, which execs node); `--json` adds this as `listener`. Before stopping a job that runs a process, `stim service install` looks for the successor that serves the unit's port from outside the job, and counts a stimd only when all of these hold: the unit's home's live exclusive stimd claim names it with the same process identity; the claim's `serviceUnit` names the label being installed. A stimd records a unit label there only with positive provenance: it runs `__stimd --service` without `--carried` (or the shim-less unit's `stim serve --service`) and the job's environment names a unit that `stim service install` wrote for its port (launchd sets `XPC_SERVICE_NAME` to the job's label, and a unit install wrote sets `STIM_SERVICE_LABEL`), and it records that label; or it was started with `--unit-successor <label>`, which a stimd holding a label passes to the successor it hands the home to. The mark guards against stopping a stimd by accident, not against a same-user process that forges it with these arguments or variables, which could signal stimd directly anyway, so it is not checked against the service manager. A plain `stim serve`, a stimd that Desktop or a command started, and a successor an older build started with `--service` alone carry no mark. The stimd must also not be attached to a command or be this process, must listen on the unit's port, and must not be the job's process, with a readable parent that is not the job's process, so it is not the job's direct child. After the job stops, install reads the claim, its identity and the listener again; when `run/stimd.json` still names that stimd it sends one SIGTERM, the signal stopping the job sends to a stimd inside it, and when the record is gone the stimd is already shutting down, so it is not signalled again, since a second signal forces its exit and records an abnormal boot. Either way install waits for it to exit within the same 45 s. Nothing is signalled on Windows, where Stim writes no engine shim, when no job is loaded, or when the job runs no process (launchd between restarts, systemd `activating (auto-restart)`). When the stimd outside the job passes every check but its claim names no unit or another label, because Stim Desktop, `stim serve`, an older build or another unit started it, install refuses before unloading the job and before its rollback path, leaves the service as it was, and names the home, the pid, `kill <pid>` and running the same `stim service install` command again, not a different command, since an install with only `--label` takes the default port and options. Stopping that stimd also stops what Desktop or that command is using. Any other listener install cannot attribute this way is left running, and install waits out the port and fails as before. `stim service uninstall` signals nothing: it keeps #5756's refusal while the home's verified stimd still listens. The stopped successor is the stimd Desktop and commands of that home share, as when it runs inside the job. Chosen by the implementing lane and the coordinating session for #5858, not by the maintainer. On Windows no stimd is marked.

A per-user service keeps worker ownership with the approving user. A version-neutral launchd or systemd shim lets the engine switch after work drains without replacing service setup or pairings. [Engine integration](https://github.com/appandflow/stim/pull/5380).

Mutating hosted work outside a reserved session, such as a runtime install,
uses its existing tracked worker as the busy fact until that worker settles.
The server's existing busy notification and `hostedWork` health fact include
it. Read-only offer and report probes do not hold succession, and the existing
owned-session takeback hold is unchanged. This closes the missing runtime
worker case from #6049 without a separate counter for each action. A bounded
runtime RPC failure does not clear busy while its worker group is unverified;
the existing group watcher proves later settlement and then clears the fact.
The pre-existing cross-thread window before stimd observes a busy notification
remains: admission racing an already committed takeback can still be cancelled.

## Code

- [Worker approval](../packages/server/src/setup.ts), [job launch](../packages/server/src/offload-jobs.ts), and [engine update authorization](../packages/server/src/handlers/engine.ts).
- [Build placement](../packages/stim-cli/src/offload/client.ts), [signing input selection](../packages/stim-cli/src/offload/signing-files.ts), and [compatibility version](../packages/stim-cli/src/engine/toolchain.ts).
- [Offload job host](../packages/stim-cli/src/job/offload/host.ts) and [worker service](../packages/server/src/service.ts).
- [Area drops a removal requests](../packages/stim-cli/src/offload/build-areas.ts) and [the worker root that serves them](../packages/server/src/build.ts).
