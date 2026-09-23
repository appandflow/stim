# Website prompt command evaluation

Run a real Codex agent against seven prompts read directly from the website:
selected iOS simulator, connected phone, recent errors, separate worktree,
three named device slots, a failed launch, and stopping the environment. The installed skill router is supplied as context;
the agent must request the built CLI's `guide agent` before taking action.
Detailed guide requests return the actual built CLI output.

This tests guide-driven command selection with a simulated project and an
intercepted structured command tool. It does not test native execution, shell
quoting, skill discovery among other installed skills, or the stock Codex tool
configuration. The native benchmark and device QA remain separate gates.

## Run

Build the repository, install Codex, and sign in with `codex login`. The runner
uses that existing login through a temporary symlink; it neither reads nor
copies credential contents, and removes the link after the child exits. Public
website prompts, the shipped skill/guides, and synthetic fixture context are
sent to the selected model using the signed-in account's usage.

```bash
pnpm run build
pnpm run test:prompts
pnpm run test:prompts logs failure
```

The default is `gpt-5.6-sol` with low reasoning effort. Set
`STIM_PROMPT_MODEL` to compare another available model and
`STIM_PROMPT_CODEX_BIN` to pin a Codex executable. `STIM_PROMPT_CODEX_AUTH` can
name another existing login file. `STIM_PROMPT_TIMEOUT_MS` lowers the per-case
180-second limit; it cannot raise it. Cases run sequentially, with at most
30 command attempts per case. They use no device memory or native build jobs.
This is an opt-in model evaluation, not an authenticated default CI test.

Each run prints its temporary evidence directory. `results.json` records pass
or failure, exact website prompt, requested model/effort, Codex version, git
revision, duration, and ordered executable/argv/cwd trace. Per-case protocol
and stderr logs preserve failures for investigation; do not commit raw runs.
The git revision identifies the checkout; rebuild after changing guides.

## What passes

A pass requires observable command attempts, never an answer containing a
command. The coordinator refuses unexpected tools, executables, flags,
workspaces, or ordering. It returns synthetic `doctor`, `start`, worktree,
slot-launch, launch-failure, and `logs` results so the agent can continue.
Stim results follow `stim guide facts payloads`: `doctor`, `start`, and `ios`
return their `--json` payload whether or not the agent passes `--json`, and a
failed launch returns the error contract with a failed tool status. `logs`
returns human output, or NDJSON with `--json`; zero matches are empty NDJSON. Agent-device requests after a
slot launch return an explicit unavailable-tool result; UI operations and
their arguments are outside this evaluation. The final target command is
intercepted without execution or a synthetic success response, then the turn
is interrupted and the app server is terminated.

- Simulator: `start`, then `ios` selecting iPhone 17 and runtime 26.5.
- Phone: `start`, then `ios --device`.
- Logs: `logs --errors --since 10m`.
- Worktree: create a separate worktree, then `worktree warm` in that directory.
- Slots: `start`, then three distinct `ios` attempts for phone, tablet (iPad),
  and hardware (`--device`). Order among the slots is unrestricted.
- Failure: `start`, then `ios`, which fails with `STIM_LAUNCH_FAILED`. The
  agent must run `logs --errors` and `guide errors STIM_LAUNCH_FAILED`, in
  either order, before any other launch attempt.
- Stop: with the environment already running, `stop`.

Flags may be reordered. Optional JSON output is accepted where supported.
The first wrong action fails the case; there is no retry-to-green. Prompt
changes may need a deliberate scenario/expectation update. Fixtures assume
prepared dependencies and available devices; apart from the failed launch,
they do not model failures.

The runner launches a fresh ephemeral app-server thread with no environments,
read-only permissions, and built-in shell, plugins, apps, browsers, computer
use, hooks, and web search disabled. The only executed Stim invocation is the
coordinator's allowlisted `guide` request. Dynamic command arguments never
reach a shell or native tool. Unsupported protocol requests fail the run.
The app-server dynamic-tool interface is experimental; protocol drift is a
failure, not a skip. See the [Codex app-server documentation](https://developers.openai.com/codex/app-server/).

## Regression checks

```bash
pnpm exec vitest run scripts/prompt-eval
```

The deterministic suite seeds wrong commands, incorrect windows/device
selectors, reused slots, wrong worktree cwd, missing guide/start ordering, a
launch retried before diagnosis, and shell injection. It compares fixture
payload fields with the CLI's own payload builders. A fake protocol peer exercises real subprocess dispatch,
interruption, trace persistence, and failed evaluation exit status. These
checks validate the harness; only a live run validates model behavior.
