# LLP 0007: Claims and child cleanup

**Type:** Decision
**Status:** Active
**Systems:** Claims, Fingerprint
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0002

## A null child is never recovered

A claim whose child file reads `{"record":null}` means an unidentified child may
still run. A claim in that state is never reaped, whatever its owner's
liveness, and Stim refuses with the claim's path, its owner and the command that
removes it. Reason: a recovered claim lets a build start while the child still
reads or writes the tree.

The unresolved-claim reason in `stim status`, `stim gc` and maintenance names
the claim path, its owner (pid and claim time, and whether it still runs) and the
command that removes the claim and child files.

## Releasing a claim after a killed fingerprint child

The fingerprint child (`bin/fingerprint-precompute.ts`) runs project code in
detached evaluators, each in its own process group. When the owner stops the
child before it writes its acknowledgement, the owner releases the workspace
claim only when all of these hold:

- the child itself and its process group are proven gone through its recorded
  identity;
- the child wrote `observing.json` next to the acknowledgement, so its ledger of
  detached groups was installed;
- every `group-*.json` entry in the owner directory is a complete record, and
  the owner has stopped each group whose leader identity still matches (never by
  pid alone) and proven it gone.

An entry that is pending, unreadable or not provably gone, a missing marker, or
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

The child answers a SIGTERM during its module load itself, because a signal
before its handler exists would kill it unacknowledged. A report with too
little budget left, or on a host above the precompute's load limit, does not
start a fingerprint child.

The rule was chosen by the coordinator and the reviews of #5547, not by the
maintainer.

Related: #5498, #5510, #5546.

## Code

- `packages/stim-cli/src/fingerprint-precompute.ts`: the release decision.
- `packages/stim-cli/src/fingerprint/detached-groups.ts`: the ledger and the
  owner's check.
- `packages/stim-cli/bin/fingerprint-precompute.ts`: the bootstrap.
