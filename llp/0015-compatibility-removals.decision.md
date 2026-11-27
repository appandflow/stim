# LLP 0015: Compatibility mechanisms that ended

**Type:** Decision
**Status:** Active
**Systems:** Engine, Server, Claims
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12

## What ended

Stim 2.0 is a breaking release. Three mechanisms that carried older builds across
the one-engine migration are gone, and each unsupported case ends in a refusal
that names its remedy:

- C23, the net thread's probe of port 7787 for a pre-1.43 stim-server.
- C25, stimd stopping dev server supervisors and device log collectors of
  another engine build at an engine switch.
- C18, the stim-ci action's refusal of a `version` below the one-package
  release and of a `stim-ci.mjs` `cli-path`.

C22, stimd's takeover of a stim-daemon from Stim 1.40, was on that list and is
back (next section). The release floors that C18 and C23 read
(`release-floors.json` and the release prep that pinned it) went with them.
`scripts/compat-budget.json` has no row for these three. One other row was marked for the removal minor and stays: C28 (a
home with paired phones and no tailnet marker gets the marker at start) ends at
the first minor after 2.0.0 is stable, since a 1.40 home never wrote the marker
and removing it would stop a paired phone from connecting after an upgrade. C27
(stimd's browser observer leaving a Chrome to an older Stim's web supervisor)
was removed with #5558.

Maintainer decision: "resume the full plan including S8", 2026-11-12. The plan
(section 3.8, step s8) names these four removals; the coordinator relayed that
the 60-day wait and the field gate are waived and that compatibility code is
cleaned up in 2.0. The coordinator, not the maintainer, chose to remove the
release floors and to give the action a missing-`bin/stim.mjs` check.

## A stim-daemon from before 2.0 is taken over

stimd holds the daemon claim shared. When a live process holds it exclusively,
only a stim-daemon from Stim 1.40 does. That daemon does not exit when
its workspaces stop: it stays until every workspace in the home is dormant,
`idle.dormantDays` after the last activity (3 days by default in 1.40), and
any 1.40 command starts it. Stim Desktop 0.3.0 runs its bundled 1.40 CLI on
every Run, Start and Revive click, so it starts that daemon again whenever no
2.0 stimd is live, and a stop by hand lasts only until the next click.

stimd takes over from it before it takes the shared claim (compat C22, ends
2.1.0), at every stimd start whatever `daemon.mode` says. It acts only when the
claim is exclusive, its `socket` is this home's pre-2.0 daemon socket, it has a
`mode` and no `build` (a 2.0 stimd's details carry one), and, in the same
synchronous step that sends the signal, `inspectProcessIdentity` of the claim's
owner reads `same`. It sends SIGTERM (on Windows `process.kill` ends the process
at once and its claim is recovered through its dead identity), because the old
daemon has no stop request. The old handler releases the claim at once and exits
after the tick in progress. stimd logs `stimd_takeover_signal` with the pid, or
why none was sent (`stimd_takeover_skipped`), waits up to 3 seconds and logs
`stimd_takeover`, or `stimd_takeover_overlap` when the process still runs. When
another 1.40 command starts a new daemon in that wait and it takes the released
claim, stimd takes that one over too, up to two more times. A CLI
command that starts stimd prints one line on stderr naming the pid it stops. The
1.40 claim and `hello` answer carry no version, so the log says Stim 1.x.

The old daemon owns no child, so dev servers (each with its own supervisor), log
collectors and owned devices keep running when it stops. A 2.0 `stim start`
reuses such a dev server as it is (`already running`). The takeover sticks: a
1.40 daemon started while a 2.0 stimd is live finds the claim held and exits.

A holder that is not a verified stim-daemon is never signalled (compat C32, ends
2.1.0). stimd's shared claim attempt fails, it logs `stimd_claim_held`, and a
detached `stimd` prints the same text on stderr, which Stim Desktop shows in
its start error. Every `stim` command that starts stimd refuses before it
launches one, and an API caller at admission, with the pid, the stop command (`kill <pid>`, `taskkill /PID <pid> /F` on
Windows) and the update remedy, with the link to the upgrade guide. `stim serve`
prints the same text. `stim status` and `stim doctor` name the holder, say
whether stimd stops it, and print the stop command; the STATUS line of
`stim guide agent` names only a holder stimd does not stop.

Maintainer decision: "a, do the takeover then cut 2.0", 2026-11-27 (#6593). Option (a) was "stimd takes over a verified Stim 1.40 stim-daemon again (SIGTERM it and take its place)".

The takeover was first added in #5630, on the coordinator's choice, and removed
in #6335 on the premise that an agent stops the old daemon once while following
the migration guide. Stim Desktop 0.3.0 breaks that premise, so the takeover is
back and the refusal stays only for a holder Stim cannot verify.

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
  the new defaults without notice. While `daemon.mode` is unset, a leftover
  `maintenance.mode` `off` or `report` also caps the daemon at `report` (it observes and acts on nothing), so a
  stimd that Desktop or `stim serve` starts does not act before the refusal shows.
- `maintenance.idleStopHours`, which is still a live setting for hosted
  sessions.
- `stim settings unset <removed key>`, which edits config files and is the only
  command that clears a leftover key. It also clears the retired 1.x keys that
  the STATUS block names (`RETIRED_SETTING_KEYS`), which have no replacement.

## Agents migrate an upgraded home from the website guide

An upgrade is a migration the agent carries out, not one the code bridges. The
For agents section of the Upgrade to Stim 2.0 page
(https://stim.appandflow.com/docs/migrate-to-2#for-agents, `UPGRADE_GUIDE_URL`)
lists each item an earlier Stim leaves, how to find it, the commands that
migrate it and when to ask the user first. It is a website page, not a
`stim guide` topic. The STATUS block of `stim guide agent`, which the skill
makes the first output an agent reads, names what is left and links the page.
It reads only state that is already on disk: the exact setting keys and
environment variables 1.x read and 2.0 refuses or ignores, a pre-2.0
daemon holding the claim that stimd does not stop, a `stim` range that admits no version of the running
major or a bundled `@stim-cli/*` dependency in the project's `package.json`,
and a `doctorRuns` record from an older major. That record, which 1.40 already
wrote, is the version marker; there is no other, and nothing acknowledges the
line: it clears when the state does. The refusals and doctor findings for
leftover settings and the old daemon link the page too. When the guide covers
a compatibility path, the next change removes the path instead of extending it.

Maintainer decision: "can u work on a migration guide aimed at agents that maybe can detect upgrade and ask agent to look at it", 2026-11-18
Maintainer decision: "I would prefer this to keeping too much backwards compat code", 2026-11-18
Maintainer decision: "I was thinking more have guide on website for agent to go read than in stim command", 2026-11-18

For 2.0 the coordinator, not the maintainer, chose to keep C29 and the C5
refusals, and to add no version marker beyond `doctorRuns`.

## Links

- Issues: #5552, #5620, #5650, #5895, #5906, #6593.
- Code: `packages/stim-cli/src/daemon/legacy-daemon.ts` (the holder check and the takeover),
  `packages/stim-cli/src/stimd/main.ts` (`daemonClaimRefusal`),
  `packages/server/src/cli.ts`, `.github/actions/stim-ci/src/action.ts`,
  `packages/stim-cli/src/guide-status.ts`, `website/docs/migrate-to-2.md`.
