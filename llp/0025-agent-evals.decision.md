# LLP 0025: Agent evals

**Type:** Decision
**Status:** Active
**Systems:** Repo
**Author:** Claude
**Date:** 2026-11-16
**Related:** LLP 0007

## The runner is our own, on demand

`packages/agent-eval` measures whether a real coding agent acts correctly on
Stim's skill, guides and command output. It is a small runner in this
repository, not a library. It drives the Claude Code and Codex command line
tools on their own subscription logins, so a run draws on the maintainer's
Claude and ChatGPT limits. Because of that cost it runs only when someone starts
it, never from pull request CI, the merge queue or a scheduled workflow, and it
caps the agent runs of one invocation.

Maintainer decision: "Lets use our own runner then", 2026-11-15.
[Issue #5776](https://github.com/appandflow/stim/issues/5776#issuecomment-6906924685).

The issue compared promptfoo, Inspect AI, Harbor, DeepEval, vitest-evals,
evalite and agent-skill-eval. With a library the two agent drivers and the
graders stay ours, and what it adds (repeats, a report) is small next to a new
dependency tree; the Python options need Docker or API keys.

## The guide text is the real text, everything else is scripted

The issue's fix idea proposes this design; the maintainer has
not stated it in these words.

The scripted `stim` that the agent finds first on its `PATH` answers
`stim guide` from the renderer in the checked-out tree, so a guide edit on a
branch is what gets measured. Every other command is answered from the case's
script. A command the script does not list is refused and logged as unscripted.
The agent never reaches the real `stim`: its `PATH` is built explicitly, and its
`STIM_HOME` is an empty directory whose later contents mark the trial invalid.

A scripted output is marked `real` when it was captured from the built CLI in a
scratch Stim home, and `synthetic` when it was written by hand. The marker lives
in the case file so a reader can tell which lines a result rests on.

## Graders are code

The issue's fix idea proposes this; the maintainer has not
stated it in these words.

A case passes on checks over the invocation log and the transcript: commands
that must have run, ordering, forbidden commands and a limit on unscripted
commands. Bytes of guide output read, turns and tokens are reported, not graded.
A case passes only when every trial passed. A help invocation never satisfies a
must-run check. A forbidden command is caught when it was executed (the scripted
`stim` logs it) or when the transcript shows an attempt in which a word with the
basename `stim` is followed later in the same simple command by the forbidden
word; spellings that hide the word, such as a variable or a script, are not
caught unless they ran. A trial whose forbidden action did not happen and whose
required evidence is missing is inconclusive, neither a pass nor a failure, so
`free-disk` passes only on a dry run; the guide's "ask the user before gc" is not
judged by code. No model judges a trial; a judge arrives only where code cannot
decide.

## Trials are confined and the maintainer's logins are protected

The reviewer of record and Codex review chose these rules for the first pull
request; the maintainer has not stated them. A trial confines each agent as far as
its CLI supports (Claude's OS sandbox and read denies, a Codex permissions profile)
and the README lists what stays readable. Each trial proves the confinement applied: the scripted `stim` tries to read a marker the runner put in the real home, and a readable or missing probe makes the trial invalid. Results are written outside every root an agent can read, are private (0700 and 0600) and are
redacted for the trial's Codex login values and token shapes. The runner never writes the
real Codex login; a file that replaced the link is moved next to it. Interruption stops the owned agent, and a
process group is signalled only while its leader has not exited, by the rule of
[LLP 0007](./0007-claims-and-child-cleanup.decision.md).

The issue and code: [#5776](https://github.com/appandflow/stim/issues/5776),
`packages/agent-eval/README.md`.
