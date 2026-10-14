# Disk pressure levels for automatic maintenance

Date: 2026-10-14. Status: accepted. Issue: #3742.

## Summary

Automatic maintenance (`maintenance.mode on`) had one disk threshold. Below
`budget.minFreeDiskGb` a pass cleared build outputs of idle workspaces and
trimmed stale cache entries, and it did the same at 19 GB free as at 1 GB. On
2026-10-13 a Mac filled while parallel agents built: two passes freed about
4.7 GB each, every later pass freed nothing because everything left was used
within `maintenance.protectRecentHours` or in use, and the last pass died with
ENOSPC while writing its state, before it acted.

This design adds three pressure levels. Each level adds stronger steps that are
still safe, and each step stops as soon as free disk is back above its level's
floor, cheapest to rebuild first.

## Levels

| Level | Entered when                                                                                | Floor its steps stop at |
| ----- | ------------------------------------------------------------------------------------------- | ----------------------- |
| 1     | free disk under `budget.minFreeDiskGb` (20)                                                 | the budget floor        |
| 2     | under `maintenance.urgentFreeDiskGb` (12), or level 1 left free disk under the budget floor | the budget floor        |
| 3     | under `maintenance.criticalFreeDiskGb` (6) or `budget.hardFloorDiskGb`                      | the larger of those two |

The free disk of a pass is the lowest of the volumes it measures: the Stim home,
the registered projects and the build worker root.

Level 2's "level 1 freed too little" clause decides its floor. Level 2 steps
are planned whenever free disk is under the budget floor, and run after level
1's steps only while free disk is still under that floor. A separate level 2
floor of 12 GB would make that clause a no-op, so level 2 has none, and
`urgentFreeDiskGb` sets only the reported level. Level 3 never enters by
shortfall, only by threshold, because its steps stop dev servers and delete
dependencies.

### Level 1

The existing pass, unchanged.

### Level 2

The protection window drops from `protectRecentHours` (2 h) to
`maintenance.pressureProtectMinutes` (10 min). In order:

1. Build outputs under `$STIM_HOME/workspaces/<id>/` (DerivedData, Gradle build,
   CAS, macOS builds) of workspaces unused for the short window.
2. Parked simulators and emulators, deleted through centralized teardown, as
   `gc --delete` does.
3. Build directories of idle worktrees: `ios/build`, `android/app/build`,
   `android/build`, `android/.gradle` and SwiftPM `.build`, at the worktree
   root, a registered project root, or `apps/*` and `packages/*`.

### Level 3

In order:

1. The Swift compilation cache, emptied whole, with no build lock or slot held.
2. Finished worktrees, with the short window as their grace period instead
   of `gc.worktreeGraceMinutes`, and only while
   `maintenance.removeFinishedWorktrees` is on. The agreed design said no grace
   period; grace 0 also skips gc's activity check, so a worktree whose pull
   request merged a minute ago would be removed while its agent still works in
   it (#1315). Its removals are level 3 actions, so they stop once free disk is
   back above the level 3 floor.
3. Workspaces inactive for the short window that run a dev server or own
   devices: the dev server stops, and the owned simulators and emulators are
   deleted through centralized teardown.
4. `node_modules` and `ios/Pods` at the root or a registered project root of
   idle linked worktrees. The source checkout is never touched.

"Idle finished-or-idle worktrees" in the issue reads as idle: a finished
worktree is still kept while it is active.

## Safety rules

Every level keeps the existing guards and adds these for directories inside a
worktree:

- Never touch a workspace that holds a lock or runs a build, anything pinned by
  `maintenance.keep`, the workspace of the command that started the pass, or
  anything the pass cannot verify.
- A directory is cleared only when its canonical path is its path under the
  worktree, so no directory above it is a link; `git ls-files` in its own
  worktree lists nothing in it; and neither it, nor the worktree's git index,
  HEAD and reflog, nor its Stim state and logs changed within the short window.
  Build directories are scanned to depth 3, dependency directories to depth 1,
  where an install rewrites entries; a tree of more than 20,000 scanned entries
  is kept as unverifiable.
- A registered project belongs to the worktree git places it in, so a worktree
  nested inside another, such as `.claude/worktrees/x`, is judged from its own
  checkout.
- Build directories ignore a running dev server, which does not use them;
  dependencies do not.
- Dirty or unpushed work only blocks removing a worktree. A dirty worktree can
  still be stopped and have these directories cleared.
- Only the listed directory names are deleted. Untracked or gitignored files in
  general are never deleted.
- Caches of other tools (pnpm and npm stores, CocoaPods, SwiftPM, the shared
  Gradle caches) are out of scope for deletion. Level 3 deletes only the
  version caches and wrapper distributions of Gradle versions no registered project pins
  and unmodified for `maintenance.gradleVersionIdleDays` (7) days, after stopping the idle
  Gradle and Kotlin daemons that would otherwise keep them (#3786).

A build that runs outside Stim, such as `swift build` or Gradle in a worktree
where no stim command ran, holds no Stim lock. The only evidence of it is writes
under its build directory, which the depth-limited scan reads.

## Triggers

Passes start from every CLI command, from `status --watch` (Desktop and
stim-server run one), and now from every dev server supervisor each minute. The
existing `due` rules still rate-limit them. With no Desktop, no stim-server, no
watch and no dev server running, no pass runs; a dedicated launchd service is
out of scope.

## Failures at full disk

A pass no longer aborts when it cannot write its state, its state lock or its
log. It notes the first write error, keeps going, frees what it can, and
reports the write error in the pass's blocked reasons. The final state write
can still fail and goes to `child.log`. A failed attempt stamp no longer stops
the trigger from spawning the pass. The pass's ownership claim still needs a
few bytes, so a pass keeps a 1 MiB `maintenance/disk-reserve` file and deletes
it when taking the claim fails with ENOSPC or EDQUOT, then retries once (#3759). The
claim protocol is unchanged, so no two passes can delete concurrently.

## Warnings

- `stim status` shows `disk pressure level N` in the maintenance line, from
  `pressure.diskLevel` in `stim status --json`.
- A pass that ends at level 3 adds a `disk pressure level 3: ...` line to
  `lastPass.blocked`. Stim Desktop decodes `lastPass.blocked` but shows only the
  action count and bytes freed, so showing the level in Desktop is a follow-up
  that needs a Desktop build.
- While the last pressure check, at most 10 minutes old, measured level 3, every
  command prints one warning line on stderr. `status --watch` and the supervisor
  do not.

## State compatibility

`MaintenanceAction` gains an optional `level` and three kinds:
`would-delete-parked-device`, `would-clear-build-dirs` and
`would-delete-dependencies`. `MaintenancePressure` gains an optional
`diskLevel`. A CLI older than this change rejects a state file whose plan holds
a new kind, treats it as absent, and starts fresh checks; it never misreads it.

## Not done

- Memory pressure still does not stop anything.
- Global caches of other tools are reported by `gc` only, as before.
