# LLP 0007: Claims and child cleanup

**Type:** Decision
**Status:** Active
**Systems:** Claims, Fingerprint
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0002

## One ownership protocol

Lock every read-modify-write to global config or workspace
state. Use atomic writes. An ownership claim held across a long operation -- a
build, an install, a supervisor lifetime -- goes through
`@stim-cli/core/ownership-claim` (re-exported by the CLI): a claim built privately
and renamed into place, named
by its own token, whose liveness is the holder's `ProcessRecord` read through
`inspectProcessIdentity`. No mtime, no heartbeat, no staleness threshold, and
no second implementation. A state it cannot establish is a refusal naming the
claim and the command that removes it, never a silent wait or a reap. A
process that cannot capture its own identity takes no claim and refuses with
`STIM_CLAIM_UNAVAILABLE`; it never runs the guarded operation unprotected.

## Short transactions and claim-set removal

Short synchronous transactions use core `withDirLock`, which shares that
claim protocol at `<lock>.claims` and retains reentrant nesting and bounded
waiting. The claim is the only lock state. Keep subprocess work outside short
locks and protect it with a child-aware claim. Only a complete claim whose
owner is proven gone is automatically recovered.
Core owns the `unique-pid` dependency and process-identity implementation;
cache packages remain usable without the CLI.
Removing a claim set is `clearFreeClaimSet`, which takes the set's own claim
first, so no sweep can delete a claim taken since it was surveyed. Device
leases use a declared expiry because the holder can be an agent with no
process. `pidExists` answers only "does a process with this pid exist"; it
cannot answer whether a record on disk still describes its writer.

A process ID can be reused after a crash, and a busy build can outlive any age limit. The claim binds ownership to process identity. The claim-set lock closes the gap between a cleanup survey and a new claimant arriving. The shared protocol also lets cache packages recover claims without depending on the CLI. [Shared ownership claims](https://github.com/appandflow/stim/pull/681), [Claim-only directory locks](https://github.com/appandflow/stim/pull/5340).

## A null child is never recovered

A claim whose child file reads `{"record":null}` means an unidentified child may
still run. A claim in that state is never reaped, whatever its owner's
liveness, and Stim refuses with the claim's path, its owner and the command that
removes it. Reason: a recovered claim lets a build start while the child still
reads or writes the tree.

The unresolved-claim reason in `stim status`, `stim gc` and maintenance names
the claim path, its owner (pid and claim time, and whether it still runs) and the
command that removes the claim and child files.

## stimd stays up for a child it can watch

A cleanup refusal that names one child and carries a way to tell when that
child has stopped does not end stimd, whether it comes from the tick, a Metro or
tunnel stop, or a job on the passes or measure thread. stimd logs
`daemon_cleanup_unverified`, holds idle exit and engine switches, and checks
the child again on every tick; once it has stopped, the claims only that
failure retained are released. Any other unverified cleanup, a thread that
crashes, and a net thread failure end stimd; its home, daemon and engine claims
stay complete, so the next start recovers them once that stimd is gone.

A thread job's check stays on that thread, which also releases the claims the
job retained. Only the child's pid and identity token cross to stimd's main
thread, with a flag the thread updates when stimd asks it to check again. The
thread does not end on idle while it watches a child, and a thread that ends
while it watches one ends stimd, since nothing can release what that child held
any more. Reason: the checks are functions that cannot be posted between
threads, and a check rebuilt from the child's pid alone would release a claim
that another child of the same job may still need (#5510).

While stimd waits, `stim status` (and `daemon.unverified` in its JSON) and
`stim doctor` list each child with when it started to wait and its remedy,
which names the commands that remove the claims the child retained. The wait
has no time limit: no clock proves that a child stopped, and a stimd that ended
for it would only move the wait to the claims.

This rule was chosen by the coordinator and the lane that implemented #5499,
not by the maintainer. The maintainer's requirement it serves, from #5499:
Maintainer decision: "We really need to fix stimd crashing and not being able to restart automatically", 2026-11-11.

## Releasing a claim after a killed fingerprint child

The fingerprint child (`bin/fingerprint-precompute.ts`) runs project code in
detached evaluators, each in its own process group. When the owner stops the
child before it writes its acknowledgement, the owner releases the workspace
claim only when all of these hold:

- the child itself and its process group are proven gone through its recorded
  identity;
- the child wrote `observing.json` next to the acknowledgement, so its ledger of
  detached groups was installed;
- every `group-*.json` entry in the owner directory is a complete record whose
  leader started at or after the child did (compared through the start times in
  the two process records); the owner stops each group whose leader identity
  still matches (never by pid alone) and proves it gone.

An entry that is pending, unreadable, older than the child or not provably gone (a record that reads as a different process ends the wait at once), a missing marker, or
a platform without process groups, keeps the claim as `{"record":null}`. No
file time and no staleness threshold decides anything.

Reason: the acknowledgement already certified exactly this set, the groups the
child started through the single exec wrapper, and a child killed or starved
before it could acknowledge left that certificate unwritten while its evaluators
were still known. Without the ledger every Desktop doctor report that exceeded
its budget under load left a null claim that kept a workspace in use for hours
(#5546).

What the ledger cannot see: a process that project code starts itself outside
exec, for example one that detaches into its own session. The acknowledgement
could not see it either; neither proves that nothing runs.

The ledger is trusted only as far as the project code the child runs, in both
directions. That code runs as the same user and can write the directory, so a
forged entry can draw a kill of a group whose leader is newer than the child, and
a deleted entry can draw a release while an evaluator still runs. No privilege
boundary is crossed: the code could send the same signal itself. The start-time
rule keeps a forged entry from naming a process that was already running when the
child started.

A child killed before it writes `observing.json` (starved during module load,
before its signal handler runs) keeps the claim as `{"record":null}`; that is a
known remaining way to a stuck claim.

The child answers a SIGTERM during its module load itself, because a signal
before its handler exists would kill it unacknowledged.

Only the read-only doctor report is gated: with too little budget left, or on a
host above the precompute's load limit, it does not start a fingerprint child,
and the prebuild-record check, the fingerprint notes and the parity check are each
replaced by a note saying so. The repair, plan and warm reports are actions the
person asked for and need the fingerprint, so they still start a fingerprint
child under load. The kill-and-settle rule above covers them, and a child killed
before it writes `observing.json` on those paths still leaves a null claim.

The start-time comparison reads the process start times in the two process
records; on macOS these are wall-clock times.

The rule, including the start-time condition, was chosen by the coordinator and
the reviews of #5547, not by the maintainer.

Related: #5498, #5510, #5546.

## Code

- [Ownership claims](../packages/core/ownership-claim.ts) and [short transactions](../packages/core/dir-lock.ts).
- `packages/stim-cli/src/fingerprint-precompute.ts`: the release decision.
- `packages/stim-cli/src/fingerprint/detached-groups.ts`: the ledger and the
  owner's check.
- `packages/stim-cli/bin/fingerprint-precompute.ts`: the bootstrap.
- `packages/stim-cli/src/stimd/cleanup-watch.ts` and `packages/stim-cli/src/stimd/threads.ts`: what stimd stays up for.
