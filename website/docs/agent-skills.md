---
title: 'Agent skill'
sidebar_position: 4
description: 'Install the small Stim workflow skill for coding agents'
---

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

Install the bundled skill from the repository:

```bash
npx skills add appandflow/stim
```

In a terminal, the skills CLI asks which agents to install to when it cannot
tell. Without a terminal, as in a script or Stim Desktop's setup guide, add
`--yes`: it installs to the agents it detects, or to `~/.agents/skills` when it
detects none.

```bash
npx skills add appandflow/stim --yes
```

The installed skill is named `stim`. It is a small discovery router that asks
the agent to load `stim guide agent` before using Stim, or `npx stim guide
agent` when `stim` is not on PATH. The CLI guide covers shared workspace
rules and routes to the workflow for your app or task, including Expo, React
Native, standalone iOS and Android, macOS, and Exact iOS.

You normally ask for the outcome: "build and run the app on iOS", "show the
recent app errors", or "run this on my connected phone". Those requests match
the skill without naming Stim. Add "use Stim" only when you want to override a
project wrapper or another tool choice.

An agent works in a separate worktree by default. Ask it to work in the current
checkout when you want that; it also does so when the task depends on your
uncommitted changes there, and says so.

Upgrading Stim also upgrades the guidance. The static skill does not need to be
reinstalled when commands or behavior change.

Stim handles local build, install, launch, and readiness checks itself. The skill
does not require a device automation package. An agent can use one separately
when a task needs taps, text input, snapshots, screenshots, or recordings.

## Report a problem

When Stim misbehaves, refuses for a reason its guide does not explain, documents
something that proves wrong, or forces an awkward workaround, the agent offers to
report it as an issue on [appandflow/stim](https://github.com/appandflow/stim/issues).
It searches existing issues first and comments on a match instead of filing a
duplicate (with your approval). The draft follows the issue template: the problem and the
expected behavior, the exact command, the `STIM_*` code and output,
`stim --version`, the OS, Xcode or Android tool versions, the `stim doctor`
findings and the workaround it used. It removes secrets, tokens, private paths,
project names and project code unless you agree to include them.

The agent shows you the draft and files it only after you approve, since the issue is public, with
`gh issue create --repo appandflow/stim`. Without `gh`, it gives you the draft
and the [new issue page](https://github.com/appandflow/stim/issues/new?template=report.md).

To ask for a report yourself:

```text
Stim got in my way just now. Search the appandflow/stim issues for it, then draft
an issue (or a comment on the matching one) with the command, error code, output,
versions and workaround, without secrets or private paths. Show me the draft
before filing anything.
```

## Clean up when a session ends

An agent that skips `stim stop` leaves a Metro server and a device running.
For Claude Code, add a `SessionEnd` hook that stops the workspace in the
session's own working directory when the session ends:

```json title="settings.json"
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e 'let d=\"\";process.stdin.on(\"data\",c=>d+=c);process.stdin.on(\"end\",()=>require(\"child_process\").spawnSync(\"npx\",[\"stim\",\"stop\"],{cwd:JSON.parse(d).cwd,stdio:\"inherit\"}))'"
          }
        ]
      }
    ]
  }
}
```

Claude Code passes the hook a JSON payload on stdin whose `cwd` field is the
session's working directory; the command above reads it and runs `npx stim
stop` there, since a hook cannot assume `stim` is installed globally. Codex CLI
has no equivalent session-end hook today (see [openai/codex#20374](https://github.com/openai/codex/issues/20374)).
