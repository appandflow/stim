# LLP 0025: Agent evals

**Type:** Decision
**Status:** Active
**Systems:** Repo
**Author:** Claude
**Date:** 2026-11-16

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
that must have run, ordering, forbidden commands, a limit on unscripted
commands, bytes of guide output read, and turns. A case passes only when every
trial passes. No model judges a trial; a judge arrives only where code cannot
decide.

The issue and code: [#5776](https://github.com/appandflow/stim/issues/5776),
`packages/agent-eval/README.md`.
