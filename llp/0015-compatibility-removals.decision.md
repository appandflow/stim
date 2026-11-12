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

- C22, stimd's takeover of a stim-daemon from Stim 1.40 to 1.42. C30 replaces it below.
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

## A stim-daemon from before 2.0 is taken over

stimd holds the daemon claim shared. When a live process holds it exclusively,
only a stim-daemon from Stim 1.40 to 1.42 does. That daemon does not exit when
its workspaces stop: it stays until every workspace in the home is dormant,
`idle.dormantDays` after the last activity (3 days by default in 1.40), and
any 1.40 command starts it. Refusing it therefore cost up to three days after an
upgrade (#5620).

stimd takes over from it before it takes the shared claim (compat C30, ends
2.1.0). It acts only when the claim's record is what a stim-daemon writes (a
`socket` and a `mode` in its details) and, in the same synchronous step that
sends the signal, `inspectProcessIdentity` of the claim's owner reads `same`. It
sends SIGTERM, because the old daemon has no stop request: its socket answers
`hello`, `snapshot`, `tick` and the slot and boot queue operations only. Its
SIGTERM handler closes the socket, releases the claim and exits after the tick
in progress. stimd waits up to 10 seconds for that identity to read `gone` or
`different`, then takes the claim and logs `stimd_takeover` with the pid.

The old daemon owns no child. It runs `ps`, `lsof` and `git` for a tick and
starts nothing that outlives it, so dev servers (each with its own supervisor),
log collectors and owned devices keep running; stimd adopts the dev servers as
it adopts any other (`adoptMetroChildren`). A takeover stops nothing else.

stimd refuses and signals nothing when the holder's record is not a
stim-daemon's, when the identity reads `unknown` or `different`, or when the
process is still running after the wait. It logs `stimd_claim_held`, and the CLI
shows the same refusal for `stim start` and for the commands that need Metro or
a managed tunnel: the pid, the stop command (`kill <pid>`, `taskkill /PID <pid>
/F` on Windows) and the update remedy (stim 2.0.0 or later). `stim serve` prints
the same text.

Known limits: the old daemon releases its claim when it receives the signal, not
when it exits, so a daemon still finishing a tick after the 10-second wait can
overlap a later stimd's first tick. On Windows `process.kill` ends the process
at once and its claim is recovered through its dead identity.

Decision: the coordinator chose this takeover in the #5620 lane brief, on
2026-11-12, not the maintainer. It reverses the part of the earlier decision
here that said stimd never signals a pid read from a claim and that the old
daemon exits on its own after its workspaces stop; that part rested on a wrong
reading of the 1.40 code. The maintainer has not stated it.

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

## Links

- Issue: #5552.
- Code: `packages/stim-cli/src/daemon/legacy-daemon.ts` (the takeover),
  `packages/stim-cli/src/stimd/main.ts` (`daemonClaimRefusal`),
  `packages/server/src/cli.ts`, `.github/actions/stim-ci/src/action.ts`.
