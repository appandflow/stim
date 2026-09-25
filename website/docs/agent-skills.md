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

The installed skill is named `stim`. It is a small discovery router that asks
the agent to load `stim guide agent` before using Stim, or `npx stim guide
agent` when `stim` is not on PATH. The normal workflow,
ownership rules, destructive-command rules, and routing to detailed topics all
come from the installed CLI and therefore match its version.

You normally ask for the outcome: "build and run the app on iOS", "show the
recent app errors", or "run this on my connected phone". Those requests match
the skill without naming Stim. Add "use Stim" only when you want to override a
project wrapper or another tool choice.

Stim uses the current checkout by default. Ask for a separate worktree when you
want isolated or parallel work; the agent may also choose one when the task
already requires that isolation.

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
