# Owned device reaping

Date: 2026-10-14. Status: accepted. Issues: #3754, #3755. Builds on the
[disk pressure levels](./2026-10-14-disk-pressure-levels-design.md).

## Summary

Owned simulators and emulators are the largest Stim-owned disk use. A disk
audit on 2026-10-14 measured 113 GB of them, every one referenced by a
registered project, so `gc` found no orphans and maintenance never deleted any.
About 39 GB belonged to workspaces with no recorded last use, which never aged
out.

Owned devices are disposable: the next `stim ios` or `stim android` recreates
one, and the shared build cache reinstalls the app. This design deletes the
owned devices of idle workspaces, measures their disk, and gives a workspace
with no recorded use a last use.

## Idle

A workspace is idle when it has no dev server, native run, build, device
lease, managed lock, driven or busy owned device, and no recorded use within the
threshold. Maintenance never deletes the devices of a workspace pinned with
`maintenance.keep`, of the workspace whose command started the pass, or of one
it cannot verify. Deletion runs under the workspace's native-run claim and goes
through centralized teardown.

## Thresholds

| When                                                  | Threshold                               | Default |
| ----------------------------------------------------- | --------------------------------------- | ------- |
| Disk pressure level 2 or 3                            | `maintenance.pressureProtectMinutes`    | 10 min  |
| No pressure, daily age sweep                          | `maintenance.deviceIdleDays` (0 is off) | 3 days  |
| Finished worktree that is kept, worktree check and gc | `gc.worktreeGraceMinutes`               | 120 min |

Level 3 still stops a workspace whose dev server runs but that is otherwise
inactive, then deletes its devices. Level 2 deletes only the devices of a
workspace with no dev server running.

A finished worktree is a linked worktree whose branch is merged into the default
branch or whose pull request was merged or closed. A clean one is removed whole,
devices included. One that `gc` keeps, for example because it is dirty, now
loses its owned devices: `gc --delete` deletes them, and so does the worktree
check of automatic maintenance. A dirty worktree's merge state is not checked
(only the states that decide its removal are), so for those the pull request is
the signal. The devices wait until the merge or the end of the pull request is
older than the grace, and outside disk pressure the window is at least
`maintenance.protectRecentHours`. A worktree kept because it is locked with
`git worktree lock`, holds another worktree, is still within its grace or has
unknown activity keeps its devices. Device deletion runs after worktree removal
in a pass, so a worktree removed whole still parks its devices.

## Parking

`worktree remove` keeps parking eligible devices into the pool (three per
platform by default). Under disk pressure level 2 or 3, measured when removal
starts, it deletes them instead and prints a note. Level 2 already deletes every
parked device.

## Last use

`workspaceLastUsed` is the newest of `lastUsedAt`, `lastBuild.startedAt`,
`supervisor.startedAt` and the log mtimes. When none exist, it now falls back to
the mtime of the workspace's `workspace.json`. It stays unknown when `state.json`
exists but does not parse, or when `workspace.json` cannot be read, so an
unreadable state still keeps its device.

`workspace.json` is written once, when the workspace directory is created, and
never rewritten, so its mtime is the creation time, a lower bound on the last
use. A workspace with no state and no logs was never used after it was created,
so creation is its last use. The device data directory's mtime was the other
candidate. It is not used: a directory's mtime changes only when a direct child
is added or removed, CoreSimulator and the emulator tools touch those entries
during their own housekeeping, and it would need a per-device lookup where the
decision is per workspace.

The fallback applies wherever the last use is read: `--older-than` device and
build-output reaping, the `--worktrees` idle check, and maintenance.

## Measurement

The size check records each owned and parked device's disk under the
`owned-devices` category: a simulator's `dataPathSize` from `simctl`, an
emulator's AVD directory through `du`. The maintenance line of `stim status`
prints the total as `owned devices`. `stim gc` prints `Owned device disk` per
platform, and `gc --json` carries `sections.ownedDeviceDisk` and
`sections.finishedDevices`.

## State compatibility

`MaintenanceAction` gains the kind `would-delete-devices`, and `MaintenanceSize`
the category `owned-devices`. As with the kinds the pressure levels added, a CLI
older than this change rejects a state file holding them, treats it as absent,
and starts fresh checks.
