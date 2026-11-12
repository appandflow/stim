# LLP 0020: Test offload

**Type:** Decision
**Status:** Active
**Systems:** Server, Transport, Builds
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12
**Related:** LLP 0008, LLP 0009

## Test approval

stim-server's `test` capability lets another machine run any command it sends
on this machine, as the worker's user, with no sandbox. It is its own
approval: it never comes with `read`, `control`, `build` or `device-host`,
and none of those grants it. A person on the worker approves it the way LLP
0009 describes for `build`: by running `stim setup --test` (or `stim-server
setup --test`) with the requesting machine's setup ticket in
`STIM_SETUP_TICKET`, which approves at most one request per capability, from
the key that holds one ticket, until one expiry. The terminal question is its
own Y/n (Enter approves), and it says that the machine may run any command it
sends, as this user, with no sandbox; `--yes` approves without a terminal. An
SSH-driven run is not offered, and setup never enables Funnel or changes TCC
for it. `stim pairings grant` and `devices grant` never grant it; they name
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

Running a test command is a remote shell for the approved machine. A build
approval already runs the client's install and Gradle scripts, but its
recipe is fixed; a test approval runs whatever the client sends. Keeping it a
separate record lets a person give build access without that, revoke one
without the other, and lets the worker check and count test work on its own.

Maintainer decision: "Separate test capability", 2026-11-12, in answer to which
permission a worker should require
([#5529](https://github.com/appandflow/stim/issues/5529#issuecomment-6834426069)).

A test-approved client may also ask the worker to update its engine
(`engine.update`), as build and device-host clients can. That, the Linux
approval and Windows refusal, `busy.tests` with the setup refusal, and the
refusal over the local socket are coordinator proposals from the plan on
#5529, not quoted decisions.

## Planned (#5529): the stim test command

Planned in [#5529](https://github.com/appandflow/stim/issues/5529); none of it is
on `main` yet. `stim test -- <argv>` runs one whole test command, given as an
argument vector with no shell and nothing read from project scripts, in the
caller's checkout or on one approved worker. The worker's stimd checks the
test approval and counts test work in its own slot class.

Maintainer decision: "Test", 2026-11-12, in answer to which name to use
([#5529](https://github.com/appandflow/stim/issues/5529#issuecomment-6834426069)).

Maintainer decision: "Auto when loaded (Recommended)", 2026-11-12, in answer to
where `stim test` runs by default: a run goes to a worker when this machine is
loaded, and otherwise runs here under a test slot.

Maintainer decision: "Yes, all three (Recommended)", 2026-11-12, in answer to
whether to start the cheap local fixes: a machine-wide test slot, splitting the
slowest integration files, and a cap on test workers.

Maintainer decision: "Use ur recs for test", 2026-11-12, in answer to the
coordinator's recommendations of the `--remote-test` flag name, separate worker
folders for tests, no environment forwarding, and conservative defaults. The
coordinator reads it as accepting the plan's other defaults too: the flags
`--remote-test`, `--timeout` and `--json`; the settings `remote.test`,
`concurrency.maxTests` and `server.testsPaused`; its exit codes; no named
commands in `.stim.json`; no Linux worker kept running; result caching out of
the first version. Those remain coordinator proposals, open to change in
review.

## Code

- [Test records](../packages/server/src/registry.ts), [approval](../packages/server/src/setup.ts), [hello](../packages/server/src/handlers/hello.ts) and [listing](../packages/server/src/cli.ts).
