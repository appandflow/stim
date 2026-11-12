# Resource model end-to-end harness

Runs the acceptance scenarios of the resource model ([#4808](https://github.com/appandflow/stim/issues/4808)) against
a built Stim on a Mac, and writes one Markdown report per run. It drives the real CLI, real simulators and real
builds. It runs on macOS only.

Where a build lacks a field an assertion needs (the daemon line, an idle stage in `status`, queue positions, the
dormant clock), the assertion reports `N/A` with the reason ("not available on this build") instead of failing. The
harness fails only when it cannot do its own work (a setup step, a gate, a teardown).

## Run it

```bash
pnpm install && pnpm run build

node scripts/resource-model-e2e/run.mjs \
  --scenario normal --project <source checkout> --stim packages/stim-cli/dist/cli.mjs \
  --workspaces 3 --out ./rm-e2e-out/normal
```

`--project` is a checkout of an Expo or React Native app that builds on the iOS simulator and carries what
`stim worktree warm` copies (`node_modules`, `ios/Pods`). `--stim` is the built `dist/cli.mjs` of the build under test.

| Option                     | Meaning                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `--scenario`               | `normal`, `disk`, `stress`, or `check` (setup, fingerprint and clock preflight, no launch)            |
| `--target`                 | `local` (default) or `ssh:<user@host>`                                                                |
| `--project`                | the source checkout (a path on the target)                                                            |
| `--stim`                   | the built `dist/cli.mjs`                                                                              |
| `--workspaces`             | worktrees to create; default `normal` 3, `disk` 5 (at least 4), `stress` 16, `check` 2                |
| `--out`                    | results directory, local even with ssh (default `./rm-e2e-out/<timestamp>-<run id>`)                  |
| `--home-dir`, `--work-dir` | where the private `STIM_HOME` and the worktrees are created (default `~/rm-e2e` on the target)        |
| `--idle-minutes`           | shorten the idle clock; the assertions then use this window                                           |
| `--dormant-minutes`        | shorten the dormant clock and assert dormancy; must exceed the idle clock (15 min when unset)         |
| `--max-load`               | start no build while the 1-minute load is at or over this value (default 40)                          |
| `--env KEY=VALUE`          | extra environment for every stim command, repeatable (for settings that have an environment override) |

The scenarios, in the order to try them:

```bash
# Preflight: worktrees, Pods repair, shared fingerprint, clocks. Launches nothing.
node scripts/resource-model-e2e/run.mjs --scenario check --project <p> --stim <cli> --workspaces 2 --idle-minutes 1

# Shortened local run of the normal scenario (what a laptop can afford)
node scripts/resource-model-e2e/run.mjs --scenario normal --project <p> --stim <cli> --workspaces 2 --idle-minutes 1

# Acceptance: 3 workspaces, default 15 min idle clock, dormant clock shortened to 20 min
node scripts/resource-model-e2e/run.mjs --scenario normal --project <p> --stim <cli> --workspaces 3 --dormant-minutes 20

# Disk pressure: project, home and worktrees must be on the volume the ballast pressures
node scripts/resource-model-e2e/run.mjs --scenario disk --project <p> --stim <cli> --workspaces 5 \
  --home-dir <dir on that volume> --work-dir <dir on that volume>

# Stress: 16 to 20 concurrent stim ios
node scripts/resource-model-e2e/run.mjs --scenario stress --project <p> --stim <cli> --workspaces 20
```

Do not run `disk` on a machine anyone is working on: it takes the volume down to 4.5 GB free for several minutes.

### On an ssh target

```bash
node scripts/resource-model-e2e/run.mjs --scenario stress --target ssh:<user@host> \
  --project <path on the host> --stim packages/stim-cli/dist/cli.mjs --workspaces 20 --out ./rm-e2e-out/stress
```

The harness packs the built stim package and its workspace dependencies with `pnpm pack`, installs them into one
self-contained tree (`npm install` from the local tarballs; the third-party dependencies come from the npm registry on
the machine running the harness), and copies that tree and the harness to `~/rm-e2e/<run id>-remote` on the host. It
starts `run.mjs --target local` there detached (`nohup`, with a pid file and a log in that directory), so a lost
connection does not stop the run, and follows the log over `ssh`, reattaching if the connection drops. When the remote
harness has exited, it copies the results into `--out` and deletes the remote directory, and `~/rm-e2e` on the host if it created it and it is empty. If the host stays unreachable it retries for 10 minutes before it stops following; the run continues there.

A local interrupt (SIGINT or SIGTERM) is forwarded to the remote harness as SIGINT, only while `run.code` does not exist and the pid's command line is the harness. The transport then waits, for at
most 20 minutes, for the remote teardown to finish, copies `out/` and deletes the remote directory. If the wait runs out
or the results cannot be copied, it leaves the remote directory in place and prints its path and the command that
removes it; it never deletes the directory while the remote harness may still be using it.

Requirements on the host: key-based ssh, Node 22.18 or later on the PATH of a login shell, Xcode, and the project at
`--project`. `--home-dir` and `--work-dir` are paths on the host. `pnpm` is needed only where the harness starts.

## Where the work happens

Before it starts, the harness prints the volume (mount point, device and free space) of the project, the private home,
the worktrees, the ballast (`disk`) and the simulators. Simulators always live on the internal disk, so the sampler
reports that volume (`disk_free_mb`) next to the home's (`home_free_mb`) and the worktrees' (`work_free_mb`).

- `--home-dir` and `--work-dir` choose the volumes. A `stress` run on a machine with a small internal disk usually
  wants both on the larger volume.
- `disk` refuses to start unless the project, home, worktrees and ballast are on one device, because only then does
  the ballast move the free space the pressure levels read.

## What it creates and deletes

Created, all named with the run id (`rme<4 hex>`):

| What                                          | Where                                                       |
| --------------------------------------------- | ----------------------------------------------------------- |
| the private `STIM_HOME`                       | `<home-dir>/<run id>-home`                                  |
| detached worktrees of the project at its HEAD | `<work-dir>/<run id>-NN`                                    |
| the ballast file (`disk`)                     | `<home-dir>/<run id>-ballast/ballast.bin`                   |
| simulators                                    | created by `stim ios`, recorded in the home's device ledger |
| results                                       | `--out`                                                     |

Every stim command runs with `STIM_HOME` set to the private home, with all other `STIM_*` variables and `CI` removed
from the environment, so no command reads or writes a real `~/.stim`. The harness refuses a `--home-dir`, `--work-dir` or
`--out` inside `~/.stim` (checked on the real paths, so a symlink into it is refused too), and any `--env` value that is
a path inside it. It never runs `stim gc`. A run id that collides with an existing home is replaced by a new
one, and the private home is created without adopting an existing directory.

Teardown runs on success, failure and SIGINT, SIGTERM or SIGHUP, and removes only what the run created. It does not
depend on stdout: write errors on stdout and stderr (EIO after a closed terminal or a dropped ssh session) are ignored,
and `events.ndjson` records every step. A second signal quits at once, but the `disk` ballast is removed by an `exit`
handler even then. The `disk` ballast path is also written to `ballast.path` in `--out`, so a run killed with SIGKILL
leaves a file named by `ballast.path` and nothing else to find it by.

1. `stim stop` in each worktree;
2. `stim worktree remove --force` in each worktree (`git worktree remove --force` if that leaves one behind);
3. `xcrun simctl shutdown` and `delete` for simulators that were in the private ledger at any point and still exist.
   This is raw `simctl`, not stim's centralized teardown, and it only ever names UDIDs from the private ledger;
4. a bounded wait for the home's `trash` to empty and for the run's stimd to exit, then
   SIGTERM and SIGKILL for a process only when it is proven the run's. stimd's title is a bare
   `stimd`, so a command line cannot be the proof; the proof is identity. A pid recorded in the private home
   (a workspace's `supervisor` (its Metro) and `collectors`, or the `run/` and `daemon/` directories) is accepted the first time it is seen
   alive, only if the process started after the run began, started no later than the moment its record first appeared
   (a process that takes the pid later is never adopted) and looks like a stim process of the run (the `stimd` title, or a
   command line naming the home or a worktree). Its start time (`ps -o lstart=` under `LC_ALL=C`) is remembered, and
   it is signalled only while the process at that pid still has that start time and still looks the same. Process
   groups of the harness's own children are signalled by group only;
5. the ballast file (checked gone), the private home (after copying `evidence/`, below), and then the work and home directories if
   the run created them and they are empty. The home is kept, with a note in the report, when `simctl list` failed
   or a simulator of the run could not be deleted, because its ledger is the proof that the simulator is the run's.

Before it creates the worktrees, the harness compares the project's tracked `ios/Podfile.lock` with `HEAD`. When it
differs it writes the committed content over the working-tree file (the index is untouched, so a staged version stays staged) and keeps
the file it replaced in `<out>/restored/ios-Podfile.lock.original`, or under a numbered name when a reused `--out` already
holds one. This is the one change the harness makes to the project checkout. The
pressure ladder deletes a workspace's Pods only when its `ios/Podfile.lock` equals the source checkout's, and the
worktrees carry the committed one, so a modified lockfile in the source (a copy of a working checkout, or any checkout
where `pod install` rewrote the checkout-path-dependent checksum) would keep rung 5 from ever acting on Pods. Pass a copy
or a checkout whose lockfile changes you do not need.

Each worktree gets `stim worktree warm`, then the harness removes the worktree's copy of `ios/.xcode.env.local` when it is untracked (`warm` carries that gitignored file from the source checkout, and it holds the source machine's `NODE_BINARY`, which breaks the first build on another host; Xcode then falls back to the committed `ios/.xcode.env`; the source checkout's file is never touched), then, when `ios/Pods` holds dangling symlinks (the source checkout's Pods can
point into an `ios/build` that was cleaned), `bundle exec pod install` in `ios/` (`pod install` without a Gemfile)
with the Ruby the Gemfile or `.ruby-version` names taken from `~/.rvm` when present and `LANG` and `LC_ALL` set to
`en_US.UTF-8`. `pod install` rewrites the checkout-path-dependent `Podfile.lock`, which would give every worktree its
own fingerprint, so the harness restores the committed `ios/Podfile.lock`, copies it to `ios/Pods/Manifest.lock`, and
then requires `stim ios --plan` to report one fingerprint for all worktrees. Otherwise it stops: every run would build
cold.

Every build waits for the 1-minute load to drop under `--max-load`. The `stress` batch starts after that gate once.

## Clocks

`--idle-minutes N` writes `idle.minutes` where the build has that setting. Builds that predate it get
`metro.idleStopMinutes` (workspace layer, in the private home) and `devices.idleShutdownMinutes` (machine layer).
`--dormant-minutes N` writes `idle.dormantDays` as `N / 1440`; a build without that setting, or one that refuses a
fraction of a day, reports the dormant assertions as `N/A`. Settings are written after `worktree warm` and before the
first command that starts anything, and read back with `stim settings get`; the effective idle value (the larger of the two
legacy settings, since a workspace is idle only when both have fired) is the window the assertions use. The `disk` scenario relies on the ladder's fixed rules (idle for 2 minutes at high pressure, 10 minutes
for dormancy), so leave `--idle-minutes` unset there.

## Sampler and report

The sampler is its own process. Every 5 seconds (nominal; under load a row can take 3 to 11 s, so every duration in the report uses the recorded
timestamps, and `took_ms` says how long the measurement took) it appends a row to `samples.csv`: 1-minute load,
memory pressure level (`kern.memorystatus_vm_pressure_level`), `vm_stat` free, active, inactive, speculative, purgeable,
wired and compressed pages with the page size, swap
used, free space on the simulators', the home's and the worktrees' volumes, booted simulators on the machine and the
run's own booted and booting simulators (those in the private ledger), and the count and RSS of the run's stimd, its
Metro child and `xcodebuild`. A process is the run's when its pid is recorded in the private home (or
descends from one that is) or its command line names the home or the worktrees. Every 30 seconds it saves
`stim status --json` to `status/<epoch ms>.json`, run from `--out` so the read is never attributed to a workspace. The
driver also polls status every 15 seconds for the assertions. The report's Sampler section lists gaps of more than three
nominal intervals, and 1-minute load readings that fell faster than an exponential 1-minute average can (a suspect
reading is flagged, not removed). A critical period that a gap follows counts up to the next sample.

`report.md` has the headline table, the assertions with their evidence lines, per-workspace results, the timeline, the
sampler as one table of per-bucket extremes (a bar column for load; no images; the memory column is available memory,
the sum of free, inactive, speculative and purgeable pages, as in the headline), and the teardown result. A path that is
absent at teardown reads as "could not verify" when its parent is absent too (a vanished volume), not as removed: the
headline then says the host was left unclean and lists the paths. Beside it:
`samples.csv`, `status/`, `runs/` (stdout, stderr and an index of every stim command), `events.ndjson`,
`assertions.json`, and `evidence/` (the daemon log and snapshot, the maintenance log, the device ledger, and each
workspace's state and the tail of its Metro log, copied before the home is deleted). The headline reads `PASS` only when something passed, nothing failed, the harness did not stop early and teardown
finished cleanly; otherwise `FAIL`, `INTERRUPTED`, `INCOMPLETE` or `NO RESULT`. Exit status: 0 when no assertion
failed, 1 when one did, 2 when the harness stopped early or its teardown did not finish cleanly.

## Assertions

An assertion over several workspaces fails if any workspace fails, passes if at least one was checked and none failed,
and is `N/A` if none could be checked.

### `normal`

N workspaces start (`stim start`) and launch (`stim ios`) one after another, then stay untouched.

| Id                        | Passes when                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch`                  | each `stim start` and `stim ios` exits 0 with `launched` true or `bundling`                                                                                                                                                                                                                                                                                                                                                                                                      |
| `idle-stage`              | each workspace is seen idle within its idle window plus one 60 s tick of its last activity, and not before the end of its last command plus the window minus one tick, except that an earlier stop passes when the daemon's log records it as a pressure idle (`high` or `critical`) and the workspace had been idle 2 minutes at that record, or, where the log has no record of it, when the build's `status` reports `daemon.pressure.level` `high` or `critical` (see below) |
| `idle-metro-down`         | at that poll `metro.running` is false (the idle-stop record is shown as evidence)                                                                                                                                                                                                                                                                                                                                                                                                |
| `idle-devices-down`       | at that poll none of the workspace's iOS devices is `Booted` or `Booting`; `N/A` when status lists no iOS device                                                                                                                                                                                                                                                                                                                                                                 |
| `idle-stage-reported`     | the environment has an `idleStage` or `dormantStage` record, looked for again once after the first idle poll because the record can be written just after Metro and the devices go down; `stage.kind` is read only to fail a workspace that is still `running` or `building` with Metro and the devices down; `N/A` otherwise                                                                                                                                                    |
| `idle-derived-data-gone`  | the workspace's `derived-data/` held files after launch and is empty or gone after the idle stop; `N/A` for a cache-hit run that built nothing                                                                                                                                                                                                                                                                                                                                   |
| `revive`                  | `stim revive --json` exits 0 with `revived.metro.restarted` true and every device's app `launched` true or `bundling`, and status then shows Metro running, a device up                                                                                                                                                                                                                                                                                                          |
| `dormant-devices-deleted` | with `--dormant-minutes`: after the revives, each workspace's recorded simulators are gone from `simctl` within the dormant window plus one 5-minute quiet tick (a home with nothing running ticks every 5 minutes at normal pressure and every minute otherwise, per section 1 of docs/specs/2026-11-02-resource-model-design.md as amended 2026-11-02 in the pressure ladder pull request, #4835); `N/A` where the build has no `idle.dormantDays`                             |
| `dormant-stage-reported`  | for each workspace that reached the dormant stage, status has a `dormantStage` record (`at`, `dormantDays`, `deletedDevices`, `archived`); `N/A` where status has none                                                                                                                                                                                                                                                                                                           |
| `dormant-deps-kept`       | for each workspace that reached the dormant stage, `node_modules` and `ios/Pods` still exist in its worktree; `N/A` for one that did not                                                                                                                                                                                                                                                                                                                                         |

Idle timing: the last activity is bounded above by the end of the last stim command in the workspace and by the newest
`lastActivityAt` in status plus one minute (status rounds it down to the minute), and never later than the poll that
read it. The deadline is that time plus the window plus 60 s. The assertion fails when a poll that started after the
deadline still saw the workspace working, or when the workspace is not idle by the end of the deadline plus five
minutes. A workspace that went idle before its last command plus the window minus one tick fails, unless the pressure ladder
was acting and the workspace had been idle 2 minutes. The daemon's own record decides: the `workspace_idle` record in
`daemon.ndjson` (with the copy in the workspace's `metro.ndjson`) whose message names `pressure level high` or
`critical`, judged at the record's timestamp. `status` reports the level after the tick's actions, so a tick that
goes high, idles workspaces and clears the pressure never shows high in a poll. A record at normal pressure stays
strictly judged. Only when the log has no record of that idle does the build's `status`
(`daemon.pressure.level`, high or critical, on the idle poll or the poll before it) decide. The evidence line says which
source allowed or refused it. The memory pressure level and the home volume's free space from the
sampler are added to the evidence but never decide it, because they are not the build's decision. Dormancy is judged
against each workspace's own revive time and has no pressure exception. Polls are 15 s apart, or twice the length of a
status call when that is longer, so an idle stop is placed to within one poll gap.

### `disk`

Workspaces: one active (a `stim reload` every 20 s), one builder (back-to-back `stim ios --no-build-cache`, which are incremental after the first, and a cold build before the last step), one probe
(`stim start`, then `stim stop`, at each step), and idle victims (the rest, at least one). The ballast steps the
volume's free space to 19, 11 and 4.5 GB (the last step is below the 5 GB hard floor, which is why it is 4.5 and not 5).
The second step waits until the victims have been idle for 10.5 minutes so that the 10-minute dormant rung is
reachable. After each step the harness observes the machine for at least 150 s and until nothing new is freed for 120 s
(at most 6 minutes), tops the ballast back up to the target, and probes. Before the last step the builder stops starting
incremental builds, deletes its DerivedData, starts a cold build and waits (up to 5 minutes) until it is compiling, so
a build is in flight when the ballast reaches the floor. The design refuses a new `start` only while free space is still
under the hard floor after the ladder ran, so a first probe at 4.5 GB may succeed because the ladder freed space; the
ballast is then topped up to 4.5 GB again and the probe repeated, up to three probes, and a probe that meets a ladder
with nothing left must refuse.

| Id                  | Passes when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch`            | the victims and the active workspace launch (fails the run early otherwise)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `freed-order`       | the ladder's actions in the daemon's log (`daemon.ndjson`, with the copies in each workspace's `metro.ndjson`: `workspace_idle` and the `pressure_action` records that did something) are in rung order by their own timestamps, within each daemon tick and for each workspace, so the dormant stage's device deletion is judged by the daemon's time of it, not by when a poll saw it; shared-cache shrinking seen by the sampler is not evidence. `N/A` when fewer than two rungs acted or the build writes no daemon log |
| `active-untouched`  | in every status poll from the first step on, the active workspace has Metro running and a device up                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `build-completes`   | every builder `stim ios` exits 0, including the cold build started before the last step; `N/A` when that build had already finished when the hard-floor ballast was in place                                                                                                                                                                                                                                                                                                                                                 |
| `only-last-refused` | the probe `stim start` succeeds at 19 and 11 GB; at 4.5 GB a probe that succeeds because the ladder freed space may come first, and the last of at most three probes refuses with `STIM_LOW_DISK`                                                                                                                                                                                                                                                                                                                            |

### `stress`

One `stim ios` in the first worktree builds the app and fills the build cache, and its workspace is stopped. Then all N
`stim ios` start at once, every worktree needs only a boot. After they finish, everything is left idle, and three
workspaces (first, middle, last of those that went idle) revive at once.

| Id                  | Passes when                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seed`              | the seed `stim ios` launches                                                                                                                                                                                                                                                                                                 |
| `exit-zero`         | every concurrent `stim ios` exits 0                                                                                                                                                                                                                                                                                          |
| `booted-cap`        | the sampled count of the run's booted plus booting simulators never exceeds `max(2, floor((RAM - 4 GB) / 1.5 GB))` (8 on a 16 GB Mac); rows without a simulator reading are left out and counted in the evidence                                                                                                             |
| `boots-in-flight`   | `capacity.devices` holders marked `booting` never exceed 2 in any status poll; `N/A` where status lists no holders (they exist only while a device cap is set); the sampler's count of simulators in simctl's `Booting` state is shown in the headline for information only, because that state can be shorter than a sample |
| `no-refusals`       | no concurrent run is refused: a run that exits non-zero with a `STIM_` code (from its JSON failure payload or its output) is a refusal, listed by code in the evidence                                                                                                                                                       |
| `pressure-critical` | memory pressure level 4 never lasts more than 60 s (a run of k samples lasts `(k - 1)` intervals plus one); rows without a level are left out and counted                                                                                                                                                                    |
| `sampler-data`      | fails when `booted_ours` or `pressure` has no value at all for the batch; each sampler-based check above is `N/A` then                                                                                                                                                                                                       |
| `idle-*`            | as in `normal`, for every run that exited 0                                                                                                                                                                                                                                                                                  |
| `revive`            | as in `normal`, for the three chosen workspaces                                                                                                                                                                                                                                                                              |

### `check`

`worktrees` (created, warmed, repaired, one shared fingerprint) and `clocks` (the idle clock is written and read back). It
polls `stim status` once so the report's daemon line is read from a real payload.

### What a `stress` run does to the machine

A `stress` run is expected to drive the 1-minute load far past 800 (the second Mac mini pass saw 920) and to keep
memory pressure at warning for minutes, with `status --json` taking close to a minute and the sampler gapping to
49 s. None of that is a failure, and the harness has no load-based abort in `stress`; `--max-load` only holds the
seed build and the batch until the machine is quiet. Whoever watches the run decides when to stop it, and the only
conditions that justify stopping it are: memory pressure critical for more than one 60 s interval, free disk under
12 GB outside the `disk` scenario's own steps, or a volume (the home, the worktrees or the project) disappearing.
An interrupt aborts every run in flight, so the runs that were killed report an exit code that says nothing about the
build.

## What it reads from a build

A field the build lacks makes its assertion `N/A`; nothing else depends on it. The harness reads:

- `stim status --json`: per environment `path`, `workspaceId`, `idleStage` and `dormantStage` (the presence of either is the idle
  stage; `stage.kind` keeps its current values and is read only to fail a workspace that is still `running` or `building`), `metro.running`, `metro.idleStop`, `metro.lastStop.reason`, `ios.state`, `ios.idleShutdown`,
  `ios.app.state`, the newest `lastActivityAt` anywhere under the environment, `build.state`, `build.phase` and
  `build.waitingFor`; `capacity.devices.max` and `capacity.devices.holders[].booting`; a top-level `daemon` (`mode`, `running.since`, `lastTickAt`).
- `stim ios --json`: `launched`, `cacheHit`, `udid`, `logs.dir` and, on failure, `code` and `message`.
- `stim revive --json`: `revived.metro.restarted` and `revived.devices[].rebooted` and `.app.launched`.
- The private home: `created-devices.json`, `workspaces/<id>/state.json` (recorded pids),
  `workspaces/<id>/derived-data`, `workspaces/<id>/logs/metro.ndjson` (the newest `bundle_response_*`,
  `expo_stdout` and `command_stdout` record, reported next to the idle-stage evidence), `run/stimd.json` (stimd's pid), and the `daemon/` directory
  (any `pid` in its JSON files; `snapshot.json` and `daemon.ndjson`, stimd's log, kept as evidence).
- Settings through `stim settings get` and `set`: `idle.minutes` (else `metro.idleStopMinutes` and
  `devices.idleShutdownMinutes`) and `idle.dormantDays`.
- The process title `stimd` in `ps`.

`idle.dormantDays` has to accept a fraction of a day, or a build has to offer an environment override in minutes
(passed with `--env`), for the dormant clock to be shortened; otherwise the dormant assertions are `N/A`.

## Limits

- The ssh transport has not been run against a real host: the package assembly and the argument passing are unit
  tested, and the assembly was run by hand.
- The `disk` scenario has not been run end to end. Its ballast, ladder ordering and assertion logic are unit tested; its
  driver has not run, because it takes a volume down to 4.5 GB free.
- A private `STIM_HOME` makes builds without the resource model run with the scoped-home defaults (no maintenance, no
  disk floors, no parking). On such a build `disk` has nothing to observe. `--env` can pass the environment overrides a
  build offers.
- The idle assertions use the last activity the harness can see. A build that counts activity `stim status` does not
  report (Metro stdout, client logs) can stop later than the computed deadline; the evidence names the newest Metro
  record to show it.
