# agent-eval

Measures whether a real coding agent does the right thing after reading Stim's
skill, guides and command output. A trial starts an agent CLI headless in a clean
temporary workspace with a scripted `stim` first on its `PATH`, then grades what
the agent ran. The package is private and is never part of pull request CI: every
trial is a real agent run on the maintainer's Claude or ChatGPT subscription.
Decisions: [LLP 0025](../../llp/0025-agent-evals.decision.md). The older
`scripts/prompt-eval` checks a single prompt per case through the Codex app
server; this runner drives whole sessions.

## What a trial can still read

An agent under test runs real commands, and everything a command prints goes to
the model provider and into `results/`. Each CLI is confined as far as it
supports, and these paths stay readable:

- **Claude Code** (Bash runs in Claude's OS sandbox with the home folder denied;
  the Read, Glob and Grep tools deny `~/**`): everything outside the home folder
  except what the CLI blocks by default: `/etc`, `/Library`, `/private/tmp` (other
  sessions' scratch files), `/Volumes`, other users' folders, and inside the home
  folder only this checkout and the Node install that runs the scripted `stim`.
  Further deny rules for `/Users`, `/private/tmp` or `/etc` broke the sandboxed
  Node on this Mac (the CLI derives sandbox rules from them), so they are not set.
- **Codex** (a permissions profile that lists what is readable: the workspace,
  the trial directories, this checkout, the Node install, `/usr`, `/bin`, `/sbin`,
  `/System`, `/Library`, `/private/etc`, `/dev`, `/opt/homebrew`,
  `/Applications/Xcode.app`): those system folders. The home folder, `/tmp` and
  `/Volumes` are denied, and the temporary `HOME` is empty. Codex still gets the
  real login through `CODEX_HOME` for itself; the agent cannot read it.

Results may hold unscrubbed tool output. Before a transcript or `stderr.txt` is
written, every string value of the Codex `auth.json` of that trial (read into
memory only) and common token shapes (JWT-like strings, `sk-` keys) are replaced
with `[redacted]`; nothing else is scrubbed. Result directories are mode 0700 and
files 0600.

## Codex login

The trial links the real `auth.json` (the `CODEX_HOME` of the caller is honoured)
and records its digest. Codex may replace the link with a refreshed token. The
runner writes that file back to the real target (a symlinked `auth.json` is
resolved first, the write is a temp file in the same directory with mode 0600 and
a rename) only when the link was replaced by a regular file, it parses as JSON, the
run was not killed by a timeout or a signal, and the real file still has its
starting digest. In every other case the real file is untouched; the refreshed copy
is kept under `results/<run>/codex-login/` (mode 0700) and the runner prints one
line saying the Codex login may need `codex login`. A `codex` session running at the
same time can rotate the token, which the digest check turns into that second case.
The write-back path has only been run against test files, not a live refresh.

## Stopping

SIGINT and SIGTERM stop the agent that is running, run the driver's cleanup,
remove the trial files, write `results.json` for what finished, and exit with 130
or 143. A second signal exits at once. The agent's process group is signalled only
while its leader has not exited, from a `setImmediate` callback (see LLP 0007).
Processes left in the group after the leader exited are never signalled: the trial
is invalid and says how many remain.

## Run

From the repository root, with `pnpm install` done (pnpm 12 passes the options as they are; do not add `--`):

```bash
pnpm --filter @stim-cli/agent-eval run eval --agent claude --case first-launch --trials 1
pnpm --filter @stim-cli/agent-eval run eval --agent both --without skill --trials 3 --max-runs 18
```

Options: `--agent claude|codex|both`, `--case <id>[,<id>]`, `--trials <n>` (3),
`--without skill|guide:<words>` (adds a second arm with no skill, or with the
output of that guide command blanked, for example `guide:errors`), `--model`,
`--max-runs <n>` (12; checked before each run, the rest are reported as not run),
`--timeout <seconds>` (300), `--bin <path>` (one agent only: not with `--agent both`) and `--out <dir>`.

Both CLIs must be logged in (`claude` on a subscription, `codex login` with
ChatGPT); no API key is read. The result goes to `results/<time>-<commit>/` (git
ignored): `results.json`, and per trial the `transcript.jsonl`, `stderr.txt` and
`invocations.jsonl`. Stdout is a Markdown table: agent, case, arm, trials passed,
median guide bytes, median turns, median tokens. A case passes only when every
planned trial passes; a trial is invalid, and does not count as a pass, when the
agent process failed, the real `stim` left anything in the agent's Stim home, or
(Claude) the agent saw a skill or MCP server it should not.

## Cost

One trial is one agent session of roughly 5 to 15 model turns. Defaults are the
cheapest setting that works: Claude `haiku`; Codex its default model at `low`
reasoning effort. The default `--max-runs 12` is three cases, three trials and one
arm plus three spare runs. Run it sparingly; the lanes share the same limits.

## Cases

`first-launch` (fresh linked Expo worktree, "run the app on the iOS simulator":
guide read, `worktree warm` exits before `start` or `ios`), `refusal` (a command
refuses with `STIM_NO_PROJECT` and a remedy: retry from the app directory; whether
`stim guide errors` was read is recorded, not graded), `free-disk` (a bare
`stim gc` deletes in 2.0: `gc --dry-run` or a question, and any `gc` without
`--dry-run` fails). Each scripted output in a case file says whether it is `real`
(captured from the built CLI in a scratch Stim home) or `synthetic` (written by
hand).

## What the scripted `stim` does

`stim guide ...` runs `packages/stim-cli/bin/cli.ts` of this checkout, so a guide
edit is what gets measured; its output bytes are logged. Other commands are
answered from the case script by argv (and optionally the directory relative to
the workspace), logged with argv, directory, times, exit code and byte counts. An
unscripted command is refused, logged, and limited by a grader. `npx stim` is the
same program.

## Isolation

Claude Code runs with the real `HOME`, because the login lives there; everything
else is switched off by flags and an explicit environment:

- `--setting-sources project --strict-mcp-config`: no user settings, hooks, plugins,
  user skills or MCP servers (including claude.ai connectors); the init event
  lists the skills, MCP servers and plugins the agent had, and a trial is invalid
  if it differs.
- `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`: no global
  or project `CLAUDE.md`, no memory. `--no-session-persistence` writes no session.
- `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` removes most bundled skills. Two stay,
  `design` and `doctor`; they are named in the init event and expected by the check.
- The skill under test is `packages/stim-cli/skill/SKILL.md` copied to
  `<workspace>/.claude/skills/stim/` (absent in the `--without skill` arm).
- Tools: `--tools Bash,Read,Glob,Grep,Skill`, `--permission-mode dontAsk` and an
  allow list: `stim`, `npx stim`, `cd`, `ls`, `cat`, `pwd`, `git status`,
  `git worktree list`, `Read`, `Glob`, `Grep`, `Skill`. There is no Edit or Write
  tool. Other commands are denied and appear in the transcript, except those on
  Claude Code's own read-only list (`du`, for one), which run, but inside the sandbox.
- Settings passed with `--settings` (a file in `<trial>/bin`): `sandbox.enabled`,
  `failIfUnavailable`, `allowUnsandboxedCommands: false`, `autoAllowBashIfSandboxed:
false`, `filesystem.denyRead: ["~/"]`, `allowRead` for this checkout and the Node
  install, `allowWrite` for the harness directory, and `permissions.deny:
["Read(~/**)"]`. A live canary showed `cat` and `ls` of the home folder denied by the
  sandbox, the Read, Glob and Grep tools denied, and the scripted `stim` working.
  Claude Code ignores a settings file that fails validation without saying so, so a
  change to these keys needs a live canary.
- `PATH` is `<trial>/bin:/usr/bin:/bin:/usr/sbin:/sbin` and `SHELL=/bin/bash`, so
  the user's zsh configuration is not sourced; the logged `PATH` of a trial shows
  the trial `bin` first. `STIM_HOME` is an empty temporary directory.
- Claude writes tool results over a size limit under `~/.claude/projects` and
  `/tmp/claude-<uid>` even with `--no-session-persistence`; the driver deletes the
  directories named after the trial workspace when the trial ends.

Codex gets a temporary `HOME` and `CODEX_HOME` with only a symlink to the real
`auth.json`, so there is no user `config.toml`, `AGENTS.md`, rules, skills,
plugins or `~/.agents` skills. Its login shell reorders `PATH`, so the temporary
`HOME` holds a `.zprofile` that puts the trial `bin` first again.
The skill is `$CODEX_HOME/skills/stim`.
Flags: `exec --json --ephemeral --ignore-rules`, `default_permissions="eval"` with a
`permissions.eval.filesystem` table (see above; the workspace and the harness
directory are writable), apps, plugins, hooks, multi-agent, browser and computer-use
features off, bundled skills off, and `model_reasoning_effort="low"`.
`codex debug prompt-input` shows the model-visible prompt and lists only the `stim`
skill.

Limits that remain:

- Neither CLI can restrict a shell to one program. Claude's allow list is a
  permission rule, Codex has no command allow list. The case script sits in
  `<trial>/bin`, which both agents can read.
- Under Codex's profile the Xcode `git` shim prints a warning because it cannot write
  its cache.
- With the plugin, remote plugin and tool suggestion features left on, Codex tried
  an account-level connector at start up and logged an authentication error. They
  are off now and the error no longer appears; the tool list itself cannot be read
  from a transcript.
- Policy settings on a managed Mac would still apply to Claude.
- The agent sees `stim` as a plain executable, not a global npm install.
- Turns: Claude's `num_turns`; Codex has no turn count, so turns are the command and
  answer items. Tokens: Claude input plus cache creation plus cache read plus output;
  Codex input plus output (`cached_input_tokens` is part of input). Cost is reported
  by Claude only, and a subscription is not billed per token.
