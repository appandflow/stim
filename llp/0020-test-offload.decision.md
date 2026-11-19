# LLP 0020: Test offload

**Type:** Decision
**Status:** Active
**Systems:** Server, Transport, Builds, Tests
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0008, LLP 0009

## Test approval

stim-server records a separate `test` approval for a requesting machine. It
never comes with `read`, `control`, `build` or `device-host`, and none of
those grants it. The operator runs `stim setup --test` (or `stim-server setup
--test`) with the requesting machine's setup ticket in
`STIM_SETUP_TICKET`, which approves at most one request per capability, from
the key that holds one ticket, until one expiry. The terminal question is its
own Y/n (Enter approves), and it says that the machine may run any command it
sends, as this user, with no sandbox; `--yes` approves without a terminal. An
SSH-driven run is not offered, and setup never enables Funnel or changes TCC
for it. Approval is terminal-only: Stim Desktop's in-app approval
(`desktop.setup.subscribe`) refuses a request that includes `test` and points
to the terminal command, until Desktop shows the test wording. Stim Desktop
lists a test record as a test client with the warning tone of a build client,
never as a phone, and offers it no View or Control. `stim pairings grant` and `devices grant` never grant it; they name
setup and `stim pairings revoke`. Test clients live in
`server/test-clients.json`, apart from `devices.json`, `build-clients.json`
and `device-host-clients.json`, and a `hello` with `access: 'test'` acts only
as that record. A connection through stimd's local socket never gets it.
`stim pairings` lists the record as kind `test-client` with access `test`, and
revoking it closes the client's connections.

A Linux worker may approve `test`. A Windows worker refuses it for now.

A worker's `/health` carries `busy.tests`, which a server that takes `test`
approvals always reports. Setup asked for `--test` refuses to reuse a running
server whose `/health` lacks it, because that server would never turn the
ticket into a record, and names the update instead.

The proposed test command would have given the approved machine a remote
shell. The build recipe fixes which project steps can run. Separate records
let a worker grant and revoke the two capabilities independently.

Maintainer decision: "Separate test capability", 2026-11-12, in answer to which
permission a worker should require
([#5529](https://github.com/appandflow/stim/issues/5529#issuecomment-6834426069)).

A test-approved client may also ask the worker to update its engine
(`engine.update`), as build and device-host clients can: to a newer exact npm
release, never a downgrade, or to the client's own packed packages only while
`server.acceptClientBuilds` is `true`. That, the Linux
approval and Windows refusal, `busy.tests` with the setup refusal, the
refusal over the local socket, and terminal-only approval are coordinator proposals from the plan on
#5529, not quoted decisions.

## Test slots and the local test command

The test slot class, `concurrency.maxTests`, and the test wait queue shipped
in #5573. Worker-side test approval shipped in #5576 and follows the rules
above.

`stim test` runs a test command on this machine under one of those slots, and
sizes the test runner's workers to the machine. Each agent's test run used to
start one worker per core, so runs from parallel worktrees overloaded the
machine and failed from CPU starvation, and nothing admitted them the way
native builds and boots are admitted.

Maintainer decision: "Can we implement a test command that would try to run tests in most optimal way? Maybe pass flags to jest to handle parallelism and avoid overloading the machine? Also support for offloading tests to othrr machine", 2026-11-18
([#5940](https://github.com/appandflow/stim/issues/5940)). The offload half is
[#5941](https://github.com/appandflow/stim/issues/5941).

This reverses the 2.0 backlog triage, which retired the earlier proposal for a
`stim test` command with automatic placement. The original proposal and the
2026-11-12 answers remain in
[#5529](https://github.com/appandflow/stim/issues/5529); the command keeps the
name decided there, "Test".

- The command takes a test slot before it starts the runner, so runs past
  `concurrency.maxTests` wait in arrival order instead of competing for cores.
- It passes a worker count, `floor((cores - 1) / concurrency.maxTests)` scaled
  down by `cores / load1` past the core count, only where the runner reads one:
  Jest's `--maxWorkers` flag, which Jest has no environment variable for, and
  Vitest's `VITEST_MAX_WORKERS`, `VITEST_MAX_THREADS` and `VITEST_MAX_FORKS`. A
  count the caller set, in the command, the environment or the runner's config,
  is kept, and any other command runs unchanged under the slot.
- The command runs in its own process group, so a signal reaches the runner
  under a package manager, and the slot is released only once that group is
  empty: a launcher can exit while its workers still run, and a queued run
  must not start beside them. Windows refuses the command, since Stim cannot
  stop that tree there.
- Without a command it runs the project's `test` script through the package
  manager whose lockfile is nearest. It reads that script only to tell whether
  it is a plain `jest` command; Stim never rewrites it.

The no-command form, the script and config checks, `--wait`, `--no-wait`, the
`STIM_TEST_RUN` marker with its nested run that takes no slot, the worker
formula, `capacity.tests` and the Windows refusal are proposals in the pull request, not quoted decisions.

## Code

- [The test command](../packages/stim-cli/src/commands/test.ts) and [its runner plan](../packages/stim-cli/src/engine/test-run.ts).
- [Test records](../packages/server/src/registry.ts), [approval](../packages/server/src/setup.ts), [hello](../packages/server/src/handlers/hello.ts) and [listing](../packages/server/src/cli.ts).
