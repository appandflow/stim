# LLP 0015: Compatibility mechanisms that ended

**Type:** Decision
**Status:** Active
**Systems:** Engine, Server, Claims
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12

## What ended

Stim 2.0 is a breaking release. Four mechanisms that carried older builds across
the one-engine migration are gone, and each unsupported case ends in a refusal
that names its remedy:

- C22, stimd's takeover of a stim-daemon from Stim 1.40 to 1.42.
- C23, the net thread's probe of port 7787 for a pre-1.43 stim-server.
- C25, stimd stopping dev server supervisors and device log collectors of
  another engine build at an engine switch.
- C18, the stim-ci action's refusal of a `version` below the one-package
  release and of a `stim-ci.mjs` `cli-path`.

The release floors that C18 and C23 read (`release-floors.json` and the release
prep that pinned it) went with them. `scripts/compat-budget.json` has no row for
these four. Two other rows were marked for the removal minor and stay: C28 (a
home with paired phones and no tailnet marker gets the marker at start) ends at
the first minor after 2.0.0 is stable, since a 1.40 home never wrote the marker
and removing it would stop a paired phone from connecting after an upgrade; C27
(stimd's browser observer leaving a Chrome to an older Stim's web supervisor)
ends with #5558.

Maintainer decision: "resume the full plan including S8", 2026-11-12. The plan
(section 3.8, step s8) names these four removals; the coordinator relayed that
the 60-day wait and the field gate are waived and that compatibility code is
cleaned up in 2.0. The coordinator, not the maintainer, chose to remove the
release floors and to give the action a missing-`bin/stim.mjs` check.

## An older stim-daemon's claim is refused, not taken over

stimd holds the daemon claim shared. When a live holder has it exclusively, only
a stim-daemon from Stim 1.40 to 1.42 does, stimd waits briefly, then exits and
logs `stimd_claim_held` with that holder's pid and the stop command (`kill <pid>`,
`taskkill /PID <pid> /F` on Windows) and the update remedy (stim 2.0.0 or
later); `stim serve` prints the same text. stimd never signals the holder. Reason: the old daemon
exits on its own once its workspaces stop, so refusing costs a wait, while
signalling a process Stim did not start is a decision for the person who runs it.

Known limit: stimd exits with status 0, so a service unit that restarts it
(30 seconds under `KeepAlive` or `Restart=always`) relaunches it every 30 seconds
until the old daemon ends.

## Dev servers of another build keep running after an engine switch

A stimd that starts after an engine switch does not stop supervisors or
collectors that record another `engineDir`. A dev server stimd itself ran is
adopted by the successor (`adoptMetroChildren`) and a Metro of other injected
files restarts at its workspace's idle point; neither needed this mechanism. The
ones that stay are processes a 1.43 build started before stimd ran Metro. They
hold their port until `stim stop`; `stim start` either reuses such a dev server or
reports `Port <n> is held by something else` and asks for the process to be stopped. `engineDir` records stay, since engine retention reads them.

## A held server port is named by pid

stim-server does not ask what answers on its port. A bind failure with
`EADDRINUSE` ends the net thread as a clean refusal that names the listening
pid, the stop command and `stim serve --port <n>`; without a pid it says the port is in use and to
pass `--port`.

## The stim-ci action does not explain old versions

The action installs the `version` it is given and runs the installed
`node_modules/stim/bin/stim.mjs` with `ci`. A package that ships no such file
fails with `stim@<version> has no bin/stim.mjs`; set `version` to 2.0.0 or later.

## Removed names get no replacement hint

C20 (removed flags and API methods name their replacement through one path) had
no code and is gone from `scripts/compat-budget.json`. C5 (one map of removed
settings and environment variables to their replacements) shrinks from 60 to 33
lines: the five removed names that only printed a replacement (`remote.buildMode`
with `STIM_REMOTE_BUILD_MODE`, `share.webrtc`, `devices.reclaimIdleMinutes`,
`daemon.enabled`, `caches.injectMetroStore`) leave the map, and the messages that
named a replacement for an unknown key go: `stim settings set` and `get` answer
"is not a Stim setting", the `stim settings` and start-command warnings and the
`stim settings --json` `unknown` entries carry no replacement, and `stim doctor`
reports a leftover key as inert. `stim settings unset` of a removed key no longer
reports `replacedBy`.

Maintainer decision on #5650, 2026-11-13: "ok sure", to the coordinator's option
B, "keep the upgrade bridges, drop the hints: keep those rows, since they expire
at 2.1.0 anyway; remove C5 and C20 and close #5634". Earlier, on #5492: "no need
for replacement we will release 2.0 I tihnk so can be breaking".

The twelve pressure-ladder settings (`budget.maxCommittedMemoryGb`,
`budget.maxLiveWorkspaces` and ten `maintenance.*` keys) and their variables
also leave the map: nothing replaced them, so their refusal was only a notice,
and they are now ignored like any unknown name.

C5 stays, smaller, as a permanent row, because the rest of the map does more than print a name. The
maintainer has not ruled on these, and the code keeps them:

- Environment variables of removed settings marked `refuses` (for example
  `STIM_MAINTENANCE`, `STIM_BUDGET_MIN_FREE_DISK_GB`): `start`, `ios`,
  `android`, `web`, `macos`, `revive` and `gc` refuse while one is set. Without
  the refusal `STIM_MAINTENANCE=off` would be ignored and `daemon.mode` would
  apply at its default.
- Old config values that turned a mechanism off (`maintenance.mode` `off` or
  `report`, `metro.idleStopMinutes` or `devices.idleShutdownMinutes` `0`) refuse
  the same commands and `stim doctor` rates them a cost, so they do not become
  the new defaults without notice.
- `maintenance.idleStopHours`, which is still a live setting for hosted
  sessions.
- `stim settings unset <removed key>`, which edits config files and is the only
  command that clears a leftover key.

## Links

- Issues: #5552, #5650.
- Code: `packages/stim-cli/src/stimd/main.ts` (`daemonClaimRefusal`),
  `packages/server/src/cli.ts`, `.github/actions/stim-ci/src/action.ts`.
