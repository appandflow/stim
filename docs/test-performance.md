# Test performance review

Measured on 2026-10-14 for [issue #3737](https://github.com/appandflow/stim/issues/3737).
Agent guidance uses affected local checks and full CI before merge. CI retains
per-case JSON timings; [testing.md](./testing.md) has the commands and graph limits.

## Cost

The successful [Linux Node 22 run](https://github.com/appandflow/stim/actions/runs/38507346213)
had 8,977 passing tests, 139 skips and 357 files. Its slowest files were:

| Suite              | File duration | Cases |
| ------------------ | ------------: | ----: |
| server/device-host |       115.18s |   177 |
| server/server      |       103.08s |   257 |
| CLI/teardown       |        54.09s |    44 |
| server/cli         |        24.57s |    16 |
| CLI/start          |        23.63s |   103 |
| CLI/status-watch   |        23.45s |    34 |

Files run concurrently, so these durations do not add up to wall time. Windows
has a different cost profile: Git/worktree and iOS/Android command fixtures are
particularly expensive. Compare reports from the same runner type.

## Trimming dispositions

DELETE: 15 cases in the iOS/Android command suites that assert only duration
formatting, abbreviation length, phase-column spacing, preparation timing prose
or an injected recorder note. These have no independent behavioral requirement,
or echo mock text; incidental copy changes invalidate their expectations.
Remove the same launch-success sentence assertion from two retained behavioral
cases. Those cases still check launch status and workspace timeline selection.
No production behavior, isolation, deadlines or test configuration changes.

The two command suites passed 952 cases before and 937 after. One local sample
changed from 32.09s to 31.70s; that is too small to establish a material speedup.
The deleted cases account for less than one second of summed case time in the
baseline. This cleanup reduces redundant coverage, rather than explaining the
suite's main cost.

KEEP the following slow contracts. Their assertions protect results and ownership
at the boundary named below, survive internal/copy changes, and exercise distinct
failure phases beyond nearby pure decision tests:

| Case                                          |     Cost | Independent requirement and failure                                                                                       | Stable boundary                                                                    |
| --------------------------------------------- | -------: | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| blocked/unknown device inventory, three cases | 15s each | Refuse deletion and retain ownership when inventory cannot be proven; never hang indefinitely or delete a foreign device. | Centralized teardown with actual child deadlines, each inventory phase separately. |
| live simulator deletion claim                 |   10.55s | Keep exclusive ownership while deletion runs; prevent another operation from using a disappearing device.                 | Real claim and process lifecycle, beyond pure lock decisions.                      |
| stalled Desktop setup                         |   10.11s | Bound setup failure without committing route configuration, leaving a later retry possible.                               | Server timeout response and unchanged route configuration.                         |
| slow adb response                             |    8.07s | Accept valid inventory within the budget and complete teardown; avoid refusing healthy but slow SDK tools.                | Real child inventory delay followed by owned emulator shutdown.                    |
| merged-worktree GC loss guards                |   varies | Never remove dirty/unpushed work or rely on failed fetches or a changed HEAD.                                             | Real Git repository and cleanup decisions; phases differ.                          |

## Selection and tools

[Vitest affected selection](https://vitest.dev/guide/cli) is already available:
`--changed origin/main` or `related --run <source>`. The API signer change selected
128 of 357 files in one preview. Generated subprocess scripts, built package
imports and filesystem reads can escape the import graph, so explicit regressions
and full CI remain necessary. A focused CI lane beside the full gate would add
runner cost; replacing the full gate needs verified dependency coverage first.

[Vitest sharding](https://vitest.dev/guide/improving-performance#sharding) is the
next CI wall-time candidate: distribute the complete suite across runners, then
require every shard. Measure shard balance and repeated checkout/install/build
cost before changing the matrix. The installed sequencer divides 358 files into
two disjoint 179-file shards. Applied to the Linux timing sample, their summed
file times are 432s and 242s, showing uneven cost; these are not wall-time
predictions. `vitest list --shard` in the installed 5.0.0 lists all files, so
that command alone does not prove shard partitioning.

The installed Vitest 5.0.0 defaults `fsModuleCache` to false. One focused Gradle
sample passed 83 cases with one Windows-only skip in 996ms cold and 507ms warm with
`--fsModuleCache`. This caches transforms and preserves fork isolation; it is a
local opt-in, not a demonstrated full-CI speedup.

[Turborepo caching](https://turborepo.dev/docs/crafting-your-repository/caching)
and [affected tasks](https://turborepo.dev/docs/reference/run#--affected), or Nx,
could help deterministic package tasks. Here build/type/lint checks take seconds
while tests dominate, and unit tests are one root task with platform/process
fixtures. Adding an orchestrator is not the first improvement. Caching a passing
test task also needs complete declared inputs, runtime and platform identity.

Keep process forks and isolation: tests change cwd/environment and depend on real
child identity. Inspect repeated subprocess/repository fixture cost in the slow
suites before deleting meaningful failures or changing deadlines.
