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
agent` when `stim` is not on PATH. The normal workflow,
ownership rules, destructive-command rules, and routing to detailed topics all
come from the installed CLI and therefore match its version.

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
