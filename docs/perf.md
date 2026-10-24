# Performance tracking

Examples use `stim`; replace it with `npx stim` when it is not installed globally.

Stim records where a command spends its time (`STIM_TRACE`) and keeps benchmark results across releases on the
`perf-data` branch. Neither is part of the release gate: nothing here blocks or slows a release. The benchmark runs
once in a while, from the weekly performance audit routine and on demand.

## Traces

`STIM_TRACE=<path>` makes one `stim` command write Chrome trace events to `<path>`. Open the file in
[Perfetto](https://ui.perfetto.dev) or `chrome://tracing`. The format and the span names are in `stim guide logs`
(TIMING TRACES) and on the website settings page.

```sh
STIM_TRACE=/tmp/ios.json stim ios
```

## Benchmark

`scripts/perf/bench.mjs` runs a fixed scenario set against one Stim build and writes one JSON file.

```sh
# a published release, installed into a scratch prefix with npm
node scripts/perf/bench.mjs --version 1.25.0 --reps 3 --publish

# a local build (pnpm run build first)
node scripts/perf/bench.mjs --cli packages/stim-cli/dist/cli.mjs --reps 3 --publish
```

The version is installed into a scratch prefix and `bench.mjs` runs that install's `cli.mjs` by path. Do not
replace this with `npx stim@<version>` from this repository: the root `package.json` lists `packages/*` as
workspaces, so when the requested version equals the workspace's own `stim` version, npx treats it as installed,
skips the download and runs whichever `stim` is first on `PATH`, which can be a different build. Run a pinned
`npx stim@<version>` from a directory outside any Stim checkout.

Each repetition adds a detached git worktree of this repository at `--sha` (default `HEAD`) and runs, from its
`apps/mobile`:

| Scenario                     | Command                                               |
| ---------------------------- | ----------------------------------------------------- |
| `warm`                       | `stim worktree warm`                                  |
| `start`                      | `stim start`                                          |
| `ios-first`, `android-first` | `stim ios`, `stim android`: new device, cache restore |
| `ios-rerun`, `android-rerun` | the same command again with the app installed         |
| `stop`                       | `stim stop`                                           |

After `warm` it runs `pnpm install --frozen-lockfile` in the worktree, not measured: `warm` carries the main checkout's `node_modules`, which can lag this commit's lockfile. It then removes the worktree. Before the measured repetitions it runs one unmeasured pass, so the build caches are
full and `*-first` measures a restore, not a cold compile (`--no-prime` skips it). A bare React Native scenario is
recorded as skipped: the repository checks in no bare fixture, and `test/e2e` generates one from the network.

For each command it records the wall time, the 1-minute load average before and after, the phases and spans from
`STIM_TRACE` when the Stim version writes one, and for a version that writes no trace, the phases stats.json recorded for the run when exactly one sample matches its time window. Per result it records
the machine (model, CPU, memory, macOS, Xcode, Node), the Stim version, and the git sha of the app source.
Versions older than `STIM_TRACE` report wall time and the stats.json phases only. The format is in the `perf-data`
branch README.

`ios` and `android` run with `--remote local --remote-build local`, so the benchmark measures this machine and never uses a remote Mac, whatever `remote.*` and `ios.remote` say. It runs the real commands against your real Stim home, on real simulators and emulators, and uses the same machine
caps as any other run. It sets `STIM_MAINTENANCE=off` for them, so automatic maintenance cannot touch other
worktrees or devices during a measurement, and it removes only the worktrees it added, through `stim worktree
remove`; it does so on interrupt too, and keeps the scratch directory and says so when a removal fails. It refuses to start while the 1-minute load average is above `--max-load` (80); with
`--wait-minutes` it waits for the load to fall instead. Use `--sha <commit>` to pin the app source when you want
two runs to be comparable across days.

`--publish` commits the file to the `perf-data` branch of `origin` through a scratch clone and pushes it. The
branch is an orphan that holds only `runs/<machine id>/<time>-<version>.json` and its README. The machine id is the
hardware model and a short hash of the host name; no host name, user name or path is stored.

## Comparing

```sh
node scripts/perf/compare.mjs
```

clones `perf-data` and prints, per machine, the latest run against the run before it: median wall time per
scenario, the change, the spread between the fastest and slowest repetition, and how many repetitions failed. A
scenario is flagged `REGRESSION` when its median grew by more than 10% and by at least 250 ms
(`--threshold`, `--min-delta-ms`). With three or more repetitions medians ignore one slow repetition, and failed repetitions are left out; a flagged change whose repetitions spread by
more than 50% is marked `(noisy)`.

Load is judged per scenario. A scenario is not compared when the median load before its commands differs by more
than 20 and by more than a factor of two between the two runs. A primed run and an `--no-prime` run are never
compared. Changes of model, macOS, Xcode or Node between the runs are noted. A run taken above load 80 is reported with a note.
A different app commit between the two runs is noted too.
