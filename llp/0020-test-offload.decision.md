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
  down by `cores / load1` past the core count, as a `--maxWorkers` flag, and
  only to a Jest or Vitest run Stim can see whole: one run directly, or a test
  script that is a plain `jest` or `vitest` command. Jest has no environment
  variable for it. Vitest's variables are not used: `VITEST_MAX_WORKERS`
  overrides `fileParallelism: false`, while the flag is applied before it, so
  a serial suite stays serial. A count the command or a visible config sets is
  kept, and any other command runs unchanged under the slot.
- The command runs in its own process group, so a signal reaches the runner
  under a package manager, and the slot is released only once that group is
  empty: a launcher can exit while its workers still run, and a queued run
  must not start beside them. A run nested in another stays in the outer
  group for the same reason. Windows refuses the command, since Stim cannot
  stop that tree there.

## A fixed worker count

The machine setting `concurrency.testWorkers` (environment
`STIM_TEST_WORKERS`) fixes the worker count every `stim test` run passes. At
`0`, the default, the count comes from the formula above. Above `0`, each run
passes exactly that count, wherever it would pass a derived one: the same
Jest, Vitest and `node --test` rules decide whether a run gets a count at all,
and the setting changes only the number. The stderr line and the
`test_workers` debug log name the setting as the source.

The formula leaves no way to pick the slot count and the worker count
together. A shared 8-core agent host that wants 4 test slots at 2 workers
each gets `floor(7 / 4) = 1` worker per run from it.

The load-based reduction does not apply to a fixed count. That host runs at a
load near its core count by design, so the reduction would cut the count back
to 1 in exactly the case the setting exists for. The operator who sets both
values has already chosen the total: at most
`concurrency.maxTests x concurrency.testWorkers` workers, which the test slots
enforce for every run that is not nested in another `stim test` run.

Maintainer decision: "Can worker count be configured", 2026-11-24
([#6223](https://github.com/appandflow/stim/issues/6223)).

Maintainer decision: "add the setting", 2026-11-24
([#6223](https://github.com/appandflow/stim/issues/6223)).

The name, the `0` default, the environment variable and skipping the load
reduction are proposals in the pull request, not quoted decisions.

## The plain form reads the test script

Without a command, `stim test` runs the project's `test` script through the
package manager whose lockfile is nearest, and reads that script only to tell
whether it is a plain `jest` or `vitest` command that can take the flag. Stim
never rewrites or replaces the script. This is an exception to the rule that
Stim does not infer commands from project scripts
([LLP 0014](./0014-native-builds.decision.md#use-fixed-invocations)): the user
asked for the project's own tests, and the script is how the project names them.

Maintainer decision: "Sounds ok for plain form", 2026-11-18, in answer to
whether to keep the plain form or always require `stim test -- <command>`
([#5944](https://github.com/appandflow/stim/pull/5944#issuecomment-6996607122)).

The script and config checks, `--wait`, `--no-wait`, the `STIM_TEST_RUN`
marker with its nested run that takes no slot, the worker formula,
`capacity.tests`, opt-in `SIGHUP` routing and the Windows refusal are proposals
in the pull request, not quoted decisions.

## Test kinds

`stim test` groups a project's tests by kind: `js`, `rust`, `android`,
`macos`, `web`, `ios`, `android-device`, `e2e-ios` and `e2e-android`, with
`e2e` standing for the `e2e-*` kinds. `stim test <kind>` runs the named kinds,
and plain `stim test` runs every kind the project has, in that order. A word
before `--` must be a kind, so an arbitrary command always goes after `--`.
When the `test` script already names another kind's runner (`cargo`,
`gradlew`, `playwright`, `cypress`, `xcodebuild`, `detox`, `maestro`), plain
`stim test` skips that kind, so it does not run twice.

Maintainer decision: "Can do all the kinds yea, lets do stim test js, stim test no args default to all kinds project has", 2026-11-18
([#5951](https://github.com/appandflow/stim/issues/5951)).

Maintainer decision: "For test go with all ur recs", 2026-11-18, accepting
the recommendations D1 to D10 of the plan on
[#5951](https://github.com/appandflow/stim/issues/5951#issuecomment-6996808445),
among them that a bare operand must be a kind and that a kind the test script
already runs is skipped.

Only `js` runs so far: a project has it when the nearest `package.json` has a
`test` script, so plain `stim test` on such a project runs what it ran before
kinds. Naming any other kind is refused with `STIM_BAD_ARG`. The other kinds
arrive one pull request at a time, as the plan's phasing on #5951 lists.
`stim test js -- <args>` passes the words to the script after the worker
flag, `stim test --list [--json]` prints the detected kinds without running
them, and node's test runner gets `--test-concurrency`, from the same formula,
where Stim sees the whole `node --test` command. The refusal of other kinds,
the `--list` payload and the `node --test` rules are proposals in the pull
request, not quoted decisions.

## Code

- [The test command](../packages/stim-cli/src/commands/test.ts), [its kinds](../packages/stim-cli/src/engine/test-kinds.ts) and [its runner plan](../packages/stim-cli/src/engine/test-run.ts).
- [Test records](../packages/server/src/registry.ts), [approval](../packages/server/src/setup.ts), [hello](../packages/server/src/handlers/hello.ts) and [listing](../packages/server/src/cli.ts).
