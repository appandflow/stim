# LLP 0026: Guidance for a refusal is its printed remedy

**Type:** Decision
**Status:** Active
**Systems:** Repo
**Author:** Claude
**Date:** 2026-11-15

Maintainer decision: "Also I think we should move as much of it as possible to output from the commands, an easy one is i think we have guide for each error, but we should just show the message when the error actually happens. Like instead of having the guidd explain when thid happens do that, it should just be when the thing happen if logs what the agent should do.", 2026-11-15.
[Issue #5773](https://github.com/appandflow/stim/issues/5773).

## A refusal prints what the agent does next

The remedy a command prints with a refusal carries the action: the command to
run, the setting to change, the thing to wait for. A new refusal puts its action
in the printed remedy. An agent that hits a refusal follows that remedy, and
reads `stim guide errors <CODE>` when the remedy is missing or does not settle
the refusal.

A guide section about a refusal that repeats what the remedy says is a second
copy to keep in step, so a section is deleted once the remedy at every emitting
site carries its action. Until then it stays.

Planned: #5773

## `stim guide errors` holds what a remedy cannot hold yet

A section stays while the remedy at any emitting site lacks its action, and for
a procedure too long for a few lines of remedy, such as the teardown and
ownership-claim recovery. A remedy that needs a section names the exact
`stim guide errors <CODE>` command. A guide, another remedy or a page that
names a section names one that renders; a test checks `stim-cli/src`, `ci/src`, `server/src`,
the guide text, `website/docs` and the stim-cli README.

Partly enforced: the `stim/refusal-remedy` lint rule counts every object literal
with a `code: 'STIM_...'` string and no `remedy`, or a literal `null`, empty or
`undefined` one, and `scripts/ratchet.mjs` fails when a package's count rises
above `scripts/ratchet-baseline.json`. The count is not zero. The rule does not
see a code assigned after construction, a class field, a dynamic code, a spread
or `diagnostics` object, or a `remedy` computed at run time.

## A code with no section prints one line

The implementing agent chose this behavior while working on
[#5773](https://github.com/appandflow/stim/issues/5773); the maintainer has not
stated it. `stim guide errors <CODE>` for a name shaped like a code (`STIM_` and
capitals) that has no section prints one line, on standard output with exit code
0, that says the printed remedy is the guidance. There is no registry of codes,
so it cannot tell a deleted code from a mistyped one; when a section name is
within two edits, or one word away, it adds a line naming it ("Did you mean
STIM_CLAIM_REFUSED?"). Any other name is an unknown section, with the index on
standard error and exit code 1.

## Warm is the agent's step, not the launch command's

start, ios, android, macos and web never warm a worktree because it is new.
Warming a new worktree is the agent's setup step: the guides have the agent run
`stim worktree warm` in it, including one a harness created, before the first
edit, install or launch there. The agent skips it when it works in place, and
for inspection, cleanup or an app already running in its workspace.

Restoring after gc is a separate case. start, ios and android run warm when
gc's record of the directories it deleted from the worktree (`lightened.json`)
lists any that are missing, whether or not the worktree was warmed before
([LLP 0001](./0001-disk-pressure-levels.decision.md#one-idle-day-reduces-a-workspace)).

Reason: a project may skip warm and install its own dependencies, so warm stays
an agent step, and the agent evals (LLP 0025) measure whether the guide text
gets agents to run it.

Maintainer decision: "I prefer no auto warm, technically someone can decide to not use warm and install its own deps, just improve guide and see if evals pass, lets just run them on codex", 2026-11-19.
[Issue #5982](https://github.com/appandflow/stim/issues/5982).

## Code

- [The errors topic and its absent-section line](../packages/stim-cli/src/guide/errors.ts) and [how the guide command prints it](../packages/stim-cli/src/commands/guide.ts).
- [The agent router](../packages/stim-cli/src/guide/agent.ts).
- [The lightened-worktree restore that start, ios and android run](../packages/stim-cli/src/workspace/lightened.ts).
