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
the machine running the harness), copies that tree and the harness to `~/rm-e2e/<run id>-remote` on the host, runs
`run.mjs --target local` there through `ssh`, streams its output back, copies the results into `--out`, and deletes the
remote copy. Requirements on the host: key-based ssh, Node 22.18 or later on the PATH of a login shell, Xcode, and the
project at `--project`. `--home-dir` and `--work-dir` are paths on the host. `pnpm` is needed only where the harness
starts. If the connection drops, the remote harness receives SIGHUP and tears down.

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
from the environment, so no command reads or writes a real `~/.stim`. The harness refuses a `--home-dir` inside
`~/.stim`. It never runs `stim gc --delete`.

Teardown runs on success, failure and SIGINT, SIGTERM or SIGHUP, and removes only what the run created:

1. `stim stop` in each worktree;
2. `stim worktree remove --force` in each worktree (`git worktree remove --force` if that leaves one behind), then
   `git worktree prune`;
3. `xcrun simctl shutdown` and `delete` for simulators that were in the private ledger at any point and still exist;
4. a bounded wait for the home's `trash` to empty and for the run's supervisors, collectors, daemon and Metro to exit,
   then SIGTERM and SIGKILL for pids recorded in the private home whose command line still matches;
5. the ballast file, the private home (after copying `evidence/`, below), and then the work and home directories if
   the run created them and they are empty.

Each worktree gets `stim worktree warm`, then, when `ios/Pods` holds dangling symlinks (the source checkout's Pods can
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
first command that starts anything, and read back with `stim settings get`; the effective idle value is the window the
assertions use. The `disk` scenario relies on the ladder's fixed rules (idle for 2 minutes at high pressure, 10 minutes
for dormancy), so leave `--idle-minutes` unset there.

## Sampler and report

The sampler is its own process. Every 5 seconds it appends a row to `samples.csv`: 1-minute load, memory pressure level
(`kern.memorystatus_vm_pressure_level`), `vm_stat` free, active, wired and compressed pages with the page size, swap
used, free space on the simulators', the home's and the worktrees' volumes, booted simulators on the machine and the
run's own booted and booting simulators (those in the private ledger), and the count and RSS of the run's supervisors,
collectors, daemon, Metro and `xcodebuild`. A process is the run's when its pid is recorded in the private home (or
descends from one that is) or its command line names the home or the worktrees. Every 30 seconds it saves
`stim status --json` to `status/<epoch ms>.json`, run from `--out` so the read is never attributed to a workspace. The
driver also polls status every 15 seconds for the assertions.

`report.md` has the headline table, the assertions with their evidence lines, per-workspace results, the timeline, the
sampler as one table of per-bucket extremes (a bar column for load; no images), and the teardown result. Beside it:
`samples.csv`, `status/`, `runs/` (stdout, stderr and an index of every stim command), `events.ndjson`,
`assertions.json`, and `evidence/` (the daemon log and snapshot, the maintenance log, the device ledger, and each
workspace's state and the tail of its Metro log, copied before the home is deleted). Exit status: 0 when no assertion
failed, 1 when one did, 2 when the harness stopped early.

## Assertions

An assertion over several workspaces fails if any workspace fails, passes if at least one was checked and none failed,
and is `N/A` if none could be checked.

### `normal`

N workspaces start (`stim start`) and launch (`stim ios`) one after another, then stay untouched.

| Id                        | Passes when                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch`                  | each `stim start` and `stim ios` exits 0 with `launched` true or `bundling`                                                                                                                       |
| `idle-stage`              | each workspace is seen idle within its idle window plus one 60 s tick of its last activity (see below)                                                                                            |
| `idle-metro-down`         | at that poll `metro.running` is false and Metro's idle stop is recorded                                                                                                                           |
| `idle-devices-down`       | at that poll none of the workspace's iOS devices is `Booted` or `Booting`                                                                                                                         |
| `idle-stage-reported`     | `stage.kind` is `idle` or `dormant`; `N/A` on builds whose stage kinds have no idle stage                                                                                                         |
| `idle-derived-data-gone`  | the workspace's `derived-data/` held files after launch and is empty or gone after the idle stop; `N/A` for a cache-hit run that built nothing                                                    |
| `revive`                  | `stim revive --json` exits 0 with `revived.metro.restarted` true and every device's app `launched` true or `bundling`, and status then shows Metro running, a device up                           |
| `dormant-devices-deleted` | with `--dormant-minutes`: after the revives, each workspace's recorded simulators are gone from `simctl` within the dormant window plus one tick; `N/A` where the build has no `idle.dormantDays` |
| `dormant-deps-kept`       | `node_modules` and `ios/Pods` still exist in each worktree after dormancy                                                                                                                         |

Idle timing: the last activity is bounded above by the end of the last stim command in the workspace and by the newest
`lastActivityAt` in status plus one minute (status rounds it down to the minute), and never later than the poll that
read it. The deadline is that time plus the window plus 60 s. The assertion fails when a poll that started after the
deadline still saw the workspace working, or when the workspace is not idle by the end of the deadline plus five
minutes; with polls 15 s apart, an idle stop is confirmed on time to within one poll.

### `disk`

Workspaces: one active (a `stim reload` every 20 s), one builder (back-to-back `stim ios --no-build-cache`), one probe
(`stim start`, then `stim stop`, at each step), and idle victims (the rest, at least one). The ballast steps the
volume's free space to 19, 11 and 4.5 GB (the last step is below the 5 GB hard floor, which is why it is 4.5 and not 5).
The second step waits until the victims have been idle for 10.5 minutes so that the 10-minute dormant rung is
reachable. After each step the harness observes the machine for at least 150 s and until nothing new is freed for 120 s
(at most 6 minutes), tops the ballast back up to the target, and probes. The builder stops starting new builds when the
last step begins.

| Id                  | Passes when                                                                                                                                                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch`            | the victims and the active workspace launch (fails the run early otherwise)                                                                                                                                                                                                                                      |
| `freed-order`       | the first time each rung freed anything is in rung order: idle stage (Metro or device stopped, DerivedData deleted), shared caches shrinking by more than 10%, device deleted (dormant), `node_modules` or Pods deleted. `N/A` when fewer than two rungs freed anything. Events are seen to within one 10 s poll |
| `active-untouched`  | in every status poll from the first step on, the active workspace has Metro running and a device up                                                                                                                                                                                                              |
| `build-completes`   | every builder `stim ios` exits 0; `N/A` when none was in flight at the start of the last step                                                                                                                                                                                                                    |
| `only-last-refused` | the probe `stim start` succeeds at 19 and 11 GB and refuses with `STIM_LOW_DISK` at 4.5 GB                                                                                                                                                                                                                       |

### `stress`

One `stim ios` in the first worktree builds the app and fills the build cache, and its workspace is stopped. Then all N
`stim ios` start at once, every worktree needs only a boot. After they finish, everything is left idle, and three
workspaces (first, middle, last of those that went idle) revive at once.

| Id                  | Passes when                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seed`              | the seed `stim ios` launches                                                                                                                                   |
| `exit-zero`         | every concurrent `stim ios` exits 0                                                                                                                            |
| `booted-cap`        | the sampled count of the run's booted plus booting simulators never exceeds `max(2, floor((RAM - 4 GB) / 1.5 GB))` (8 on a 16 GB Mac)                          |
| `boots-in-flight`   | `capacity.devices` holders marked `booting` never exceed 2 in any status poll; `N/A` where status lists no holders (they exist only while a device cap is set) |
| `booting-sampled`   | the sampled count of the run's simulators in the `Booting` state never exceeds 2 (supplementary, 5 s resolution)                                               |
| `no-refusals`       | no run's output carries `STIM_AT_CAPACITY` or `STIM_LOW_DISK`                                                                                                  |
| `pressure-critical` | memory pressure level 4 never lasts more than 60 s (a run of k samples lasts `(k - 1)` intervals plus one)                                                     |
| `idle-*`            | as in `normal`, for every run that exited 0                                                                                                                    |
| `revive`            | as in `normal`, for the three chosen workspaces                                                                                                                |

### `check`

`worktrees` (created, warmed, repaired, one shared fingerprint) and `clocks` (the idle clock is written and read back).

## Limits

- The `ssh` transport has not been run against a real host by its author; the package assembly and the argument
  passing are unit tested and the assembly was run by hand.
- A private `STIM_HOME` makes builds without the resource model run with the scoped-home defaults (no maintenance,
  no disk floors, no parking). On such a build `disk` has nothing to observe. `--env` can pass the environment
  overrides a build offers.
- `disk` and `stress` were not run on the machine that developed the harness (see the pull request for what was).
