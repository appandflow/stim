# Stim agent guide

Use this guide when you change this repository. State rules here in the
present tense: a rule's history lives in issues and commits, not here. User documentation lives in
[`packages/stim-cli/README.md`](./packages/stim-cli/README.md).

## Project

Stim gives each React Native or Expo workspace an isolated Metro port and an
owned simulator or emulator. It caches native builds and captures structured
logs.

The normal flow is:

```text
git worktree add -> cd -> worktree warm -> start -> ios|android -> logs --errors -> stop -> worktree remove
```

The command surface is `doctor`, `worktree warm|remove`, `start`, `stop`,
`ios`, `android`, `web`, `reload`, `revive`, `agent-device`, `share [stop|list]`, `ports [get|stop|release|reverse]`, `device lock|unlock|provision|location|permission|push|network`, `logs`, `remote add|list|remove`, `settings [get|set|unset]`,
`status`, `stats`, `gc`, `guide`, `serve`, `pair`, `pairings`, `service`, `setup`, `ci`, and `engine status|use|install|update|rollback|uninstall`. Do not add commands or flags without an explicit product decision.
Projects can wrap Stim when they need custom behavior.

Runtime state belongs under `$STIM_HOME/workspaces/`, not in the project
tree. Stim has no init step; do not add one. `doctor` reports setup that
requires project judgment.

## Development

The repository is a pnpm workspace. Published packages live under `packages/`.
The packages are ESM-only. They require Node.js 22.12.0 or later. Repository
development requires Node.js 22.18.0 or later because tsdown uses that floor.

```bash
pnpm install
pnpm run format:check
pnpm run lint
pnpm run build
pnpm run typecheck
pnpm run knip
pnpm test
pnpm run test:runtime
```

Run affected checks locally before committing: the regression tests for changed
behavior and the applicable formatting, lint, build and type checks. A prose-only
change needs formatting, not the unit suite. Use CI for the full unit suite,
dead-code, runtime-floor and RPC gates; all required checks and the merge gate
must pass before merging. A PR that only modifies existing root unit test files
runs those files first; its merge candidate still runs the full unit suite.
Other PRs run the unit stage on their pushed head; main and manual runs also
run integrations. Run a full local suite when investigating a broad regression, changing shared test setup or discovery, or
when CI cannot validate the affected behavior. Do not repeat a passing check on
unchanged code without a new failure or unresolved concern. Run
`pnpm run test:e2e` when a change affects an end-to-end workflow, and keep the
real-tool and app verification requirements below. Candidate version commits
follow the preflight in [`RELEASE.md`](./RELEASE.md), which leaves the checks
that CI runs on the release commit to CI.

A pull request, the merge queue and a push to `main` run only Linux jobs and,
when Desktop files change, `swift build -Xswiftc -warnings-as-errors`.
The macOS and Windows unit suites, native process inspection, Desktop `swift
test` and Release compile, the mobile license check and the native E2E smoke run
in the `Full suite` workflow: nightly, on dispatch, and before a stable release
(`RELEASE.md`). A failing nightly files a `Nightly failure:` issue labeled
`source: nightly`; read those issues first when `main` looks broken on one
platform. Run platform-specific changes on that platform before committing:
the vitest files that branch on `process.platform` on macOS, and `swift build`
and `swift test` with warnings-as-errors for Desktop. Add the `ci-full` label
to a pull request that changes native tool calls (invariant 9), Desktop Swift,
the frames helper or other macOS or Windows code paths, and wait for `Full
suite` before the fresh review; for a branch without a pull request run
`gh workflow run full-suite.yml --ref <branch>`.

Filter unit tests with `pnpm test <file> -t "case name"`. Do not insert `--`
before the file: pnpm forwards it to Vitest, which then ignores the filter and
runs the full suite.

`pnpm test --changed origin/main` selects tests through Vitest's dependency
graph. Use it alongside explicit regressions, not as the only coverage decision:
generated subprocess scripts, built package imports and filesystem reads can
hide dependencies from that graph. See [the local validation workflow](./docs/testing.md#local-validation)
for selection and timing commands.

The macOS app lives in `apps/desktop`, a Swift package outside the pnpm
workspace; see its README. It reads state and runs Stim operations through the
matching-home stim-server, the net thread inside that home's stimd. It never
reads or writes `$STIM_HOME` beyond `run/stimd.json` and `run/desktop.key`, and
never falls back to an external Stim CLI. It proves the key in `run/desktop.key`
(0600, written by stimd when it starts) with `desktop.authenticate` for its
Desktop-only methods; a local connection without that proof keeps the local
read and control capabilities only. A separately installed CLI is optional for
coding agents and terminal use. External bootstrap tools run through
`ProcessStream`.
It connects through stimd's CLI socket, whose path `run/stimd.json` names
(normally `$STIM_HOME/run/stimd.sock`; when that path exceeds macOS's 103-byte
limit, `/tmp/stim-sockets-<uid>/<sha256-of-normalized-socket-path>.sock`). The
first frame is `{"kind":"desktop"}`; `net.ensure` starts the net thread and
answers `{port, listening: true}` or why it cannot start, and `net.connect`
hands the rest of that connection to the net thread, where it speaks the
WebSocket protocol as a local client. The socket's directory is mode 0700 and
owned by stimd's user; the socket serves only that user without pairing or
Noise. stim-server binds no Unix socket of its own. It may also pair, as a client, with another machine's
stim-server, as the phone app does: it spends a `stim pair` token in
protocol 2's Noise handshake, requires the payload's server-key fingerprint, and
keeps its per-pairing client private key and pinned server key in the macOS
Keychain, never under `$STIM_HOME`. The pinned key is the trust boundary;
Desktop accepts only tailnet endpoints, and `stim pair` refuses a Funnel
route. A remote server grants it only the capabilities recorded for its key:
`read`, plus `control` for a `--control` pairing. `desktop.*`, `route.setup`,
`machines.update.*` and `device-host.sessions*` stay Unix-socket-only. Desktop
treats every remote message as untrusted input, never turns a remote path into a
local file or process, and never stores another machine's workspace data on
disk. Build and test it with `swift build` and
`swift test` from that directory, both with `-Xswiftc -warnings-as-errors`; a
pull request's CI runs the build, the `Full suite` runs the tests. Format and lint its Swift sources with `scripts/format.sh` and
`scripts/format.sh --check`. Its design tokens and empty-state agent prompts are generated from
`apps/mobile/src/design/tokens.ts` and `apps/mobile/src/lib/agent-prompts.ts`; run
`node apps/desktop/scripts/generate-tokens.mjs` after changing either file. Keep
its `Sources` ASCII-only, with `\u{XXXX}` escapes; `node apps/desktop/scripts/check-ascii.mjs` checks it.

Every Desktop change must build and launch the worktree's `apps/desktop` through
`stim macos` from that directory. Follow `stim guide macos` for the
version-matched workflow. When verification needs interaction, use agent-device
with `AGENT_DEVICE_MACOS_APP_BACKEND=native`. Check `stim logs --errors`, then
run `stim stop` from that directory to stop the workspace's owned app.

The read-only phone app lives in `apps/mobile`, an Expo app in the pnpm
workspace named `stim-mobile`; see its README. Of the root checks above, only
`pnpm run knip` covers it. Run `pnpm run format:check`, `pnpm run lint`,
`pnpm run typecheck`, `pnpm run intl:check` and `pnpm test` from that directory.
Develop it with Stim and its mock server, which replays captured Stim payloads.

Native tool compatibility runs separately with `pnpm run test:compat`. Follow
[the test-stage prerequisites and evidence rules](./docs/testing.md) when changing
native tool calls or preparing a release. Missing hardware is unavailable
validation, never a compatibility pass.

## Tests and abstractions

Before adding a test, name the independent requirement or bug and the concrete
failure it catches. Its expected result must be able to disagree with the
implementation. Prefer command and public API tests that exercise real
collaborators, with mocks at external boundaries. Keep focused lower-level
tests for complex parsing, algorithms, decision logic and regressions when
they protect behavior the API tests do not. Simple helpers already covered
through their callers do not need their own suite. Search existing tests and
extend a relevant case instead of repeating it at another layer.

Choose representative equivalence classes and boundary cases in parameter
tables. Each row must protect a distinct contract, boundary or known failure
mode; extra spellings and combinations do not justify more cases by themselves.
Use a cross-product only when the interaction between its dimensions is a
requirement. Repeating the same assertions at a second layer or on another
platform requires a distinct contract there.

Do not add tests that only check a constant, a pass-through call, import spelling,
or implementation source text. A mock returning the expected result does not
prove the operation works. Use mocks for external boundaries and assert the
behavior Stim adds. Keep regression tests for real failure modes even when the
implementation is short.

Unit tests use fake clocks by default. Test timeout and retry policy with
immediate external failures, explicit clock advancement or controlled events.
Real-clock contracts, such as OS process termination, socket deadlines and
filesystem watchers and CPU performance budgets, belong in
`*.integration.test.ts` or
`*.integration.test.mjs`; name the real interaction the test protects. Do not
disable fake clocks in a unit test or repeat executor deadline waits in every
caller. Synchronize fixture readiness with events or handshakes instead of
fixed sleeps.

For bulk test changes, report the expanded case count and measured runtime;
parameter-table rows count as cases. Compare line, branch and function coverage
when removing tests. A test's failure history informs this decision, but a test
that has never failed can still protect a distinct regression or safety rule.

Guide tests protect rendering, routing, safety instructions, and agreement with
code-defined contracts such as error codes and settings. Keep assertions to the
contract being protected. Do not copy explanatory paragraphs, website prose, or
examples into regex assertions; documentation edits do not need matching tests
unless they change one of those contracts. Narrow source scans for documented
identifiers are allowed; they do not replace tests of the behavior behind them.

During test cleanup, classify individual candidates as DELETE, REWRITE, or KEEP.
Default suspect tests to DELETE. Adding a test or choosing KEEP or REWRITE
requires evidence for all six:
an independent requirement, a recognizable user/caller failure, an expectation
independent of the implementation, a stable behavioral seam, survival through
internal refactors and incidental copy/layout changes, and the lowest stable
seam without redundant nearby or higher-layer coverage. Rewriting is an
exception for a real contract that would otherwise be lost; do not invent a
requirement to preserve a test.
Treat search matches as leads, not verdicts. Remove unused test support, keep
production behavior and test configuration unchanged, and record dispositions
and validation. Mock echoes, private call shapes, inventory counts, generated
markup and incidental prose or geometry do not meet this bar. Keep explicitly
required guide contracts and device input/frame-routing geometry; justify the
specific contract instead of exempting the whole suite. Use screenshots for
appearance review unless an approved contract requires automated visual coverage.

Use a direct call or re-export when a wrapper only forwards the same arguments
and result. Keep helpers that own policy, coordinate effects, or remove meaningful
duplication. Do not extract a helper or export an internal function solely to
give it a unit test.

## Issue and pull request workflow

When you find a bug or improvement, search the open GitHub issues first. If no
issue already describes it, create one before implementation, following the
shape in `.github/ISSUE_TEMPLATE/report.md`. Refresh the remote refs, then
confirm that an existing issue still applies to current
`origin/main`; close stale issues with the fixing commit and verification
evidence instead of creating duplicate work.

Label every issue when you create it: exactly one `type:`, exactly one
`priority:`, and every `area:` it touches. When you work on an unlabeled issue,
label it first. Pull requests carry `area:` and `review:` labels, plus
`security` and the `e2e-*` labels that select CI lanes; the linked issue holds
the type and priority.

- `type: bug` breaks documented or expected behavior. `type: feature` adds or
  changes behavior, including performance and polish. `type: chore` changes no
  runtime behavior: documentation, refactors, tests, workflows, tooling,
  dependency updates. `type: investigation` produces findings rather than a
  change: diagnose, measure, benchmark, prototype, evaluate.
- `priority: P0` is broken for users with no workaround, data loss, a security
  exposure, or a release blocker. `priority: P1` is next up: a user-facing
  defect or a feature that unblocks other work. `priority: P2` is normal and the
  default when unsure. `priority: P3` is nice to have.
- `area: cli` is `packages/stim-cli`, including its README and guide.
  `area: core`, `area: cache`,
  `area: metro`, `area: server` and `area: ci` are the matching `packages/`
  directories; `area: ci` is the CI implementation, not GitHub workflows.
  `area: desktop` is `apps/desktop`. `area: mobile` is `apps/mobile` and its
  mock server, `apps/demo-server`. `area: website` is `website/`, and
  `area: docs` is `docs/` and the root documents. `area: repo` is everything
  else: `.github/`, `scripts/`, `test/`, `packaging/`, `patches/` and root
  configuration.

Claim an issue before you implement it. Every agent works as the same GitHub
user, so assignees mean nothing; the claim is a comment plus a branch. Before
starting, check the issue for an open pull request or a `Claimed: <branch>`
comment newer than one day (by its `createdAt`) with no later `Released:`
comment and that branch on `origin`. When either is present the issue is taken;
pick another. When you choose an issue yourself, take the highest priority among
free issues, and treat an unlabeled issue as `priority: P2`. To claim, comment
`Claimed: <branch>`, then push the branch to `origin` before implementing
anything. The open pull request replaces the claim. If you stop without one,
comment `Released:` and delete the branch. The `stale-claims` workflow posts
`Released:` on a claim older than two days with no open pull request or recent
commit on its branch; it never deletes a branch, so release your own claim when
you stop.

Implement each valid issue in its own git worktree and branch created from the
refreshed `origin/main`. Independent issues may run in parallel worktrees. Keep
the branch limited to that issue, run the required checks, and open a pull
request that links the issue, with a description following
`.github/PULL_REQUEST_TEMPLATE.md`.

A change that depends on an unmerged pull request branches from that pull
request's branch and links the two as a GitHub stack with `gh stack link
<lower> <upper>` (bottom to top), so the diff shown is against the parent, not
`main`. The pull request body names the dependency, and every member still gets
its own review and CI. Merge the stack bottom-up with `gh stack merge` once
every member is clear and green. Independent issues stay separate pull
requests; do not stack to skip a review.

As soon as the pull request is open, assign a fresh agent that did not implement
the change to review the issue, diff, tests, and user-facing guidance. Address
every actionable finding and rerun the affected checks. Mark the pull request
ready only after that fresh review is clear. Merge only after all required CI
checks pass, and after `merge gate`, which waits for every other check, has
passed; if CI fails, fix the branch, repeat the review, and wait for the
new checks.

The fresh reviewer records the outcome with labels. When the review is clear, it
adds `review: ai-approved` and marks the pull request ready with `gh pr ready`.
When the diff contains a product decision the maintainer has not stated, it adds
`review: needs-human` and removes any `review: human-approved`. A product
decision is a new, removed or renamed command, flag or setting; a changed
default; or a change to user-visible behavior beyond what the linked issue
asked for. This is the "explicit product decision" that new commands and flags
require. Only a decision the maintainer stated counts as approved: an issue or
comment that quotes the maintainer's words as a decision, in a line such as
`Maintainer decision: "<words>", <date>`, or one the maintainer wrote directly.
Every agent posts as the maintainer's account, so an agent's own proposal,
design section or "Fix idea" never counts, whoever posted it. The reviewer looks
for the quoted decision before treating a new command, flag, setting or default
as approved.

Other concerns do not add the label. The reviewer still names them in its
review: a new or wider way for another machine to reach or act on this one (a
network listener, an authentication or pairing path, a stim-server capability),
how secrets, tokens or signing keys are stored, passed or exposed, deleting or
killing something Stim does not own, a new ownership rule, a release or
publishing workflow that holds secrets, and a breaking change to on-disk state
or a published contract. The Required invariants and `RELEASE.md` govern them.
When it is unclear, leave the label off and name the concern in the review;
that alone does not block `review: ai-approved`.

With that label, the reviewer posts a comment that starts with `Human review:`
and lists each unapproved `path:lines`, linked at the reviewed commit, with one
line saying why. A maintainer reviews those lines and replaces
`review: needs-human` with `review: human-approved`; `review: ai-approved`
stays. A change counts as approved when its lines are unchanged since the
commit a `Human review:` comment linked before that approval. GitHub approvals
cannot record this because every agent uses the same account.

Any push after a review removes `review: ai-approved`, and the pull request
gets a new fresh review. Merge, including with `gh stack merge`, only when
every pull request involved has `review: ai-approved` and none has
`review: needs-human`.

Polish changes to `apps/desktop` or `apps/mobile` can share one issue, branch,
review and CI run. A polish change alters only how an app looks or reads:
layout, styles, copy, icons, animation. It does not change which commands the
app runs, which Stim data it reads or how it decodes it, navigation,
dependencies, native modules, the device frame pipelines, or app and build
configuration. Collect polish changes under one tracking issue that lists each
change, claimed and worked like any other issue; when an open issue already
describes a change, link it from the list and close it with the pull request.
Keep one commit per change. The pull request shows a screenshot or recording of
each change on each platform it affects, and gets the same fresh review and
green CI as any pull request; a commit added after the review needs a new review.
The reviewer checks each commit against this definition, and one that falls
outside it moves to its own issue and pull request.

## Architecture rules

- **Single exec wrapper.** Route all child processes through
  `packages/stim-cli/src/exec.ts`. Use `runFile` for user-controlled paths.
  Lint rejects value imports of `node:child_process` and `cross-spawn`
  elsewhere in the CLI source.
- **Pure parsing and decision logic.** Keep parsers and selectors separate from
  thin I/O wrappers. Test complex logic directly when it adds distinct coverage;
  simple helpers remain covered through their callers.
- **Locked state.** Lock every read-modify-write to global config or workspace
  state. Use atomic writes. An ownership claim held across a long operation -- a
  build, an install, a supervisor lifetime -- goes through
  `@stim-cli/core/ownership-claim` (re-exported by the CLI): a claim built privately
  and renamed into place, named
  by its own token, whose liveness is the holder's `ProcessRecord` read through
  `inspectProcessIdentity`. No mtime, no heartbeat, no staleness threshold, and
  no second implementation. A state it cannot establish is a refusal naming the
  claim and the command that removes it, never a silent wait or a reap. A
  process that cannot capture its own identity takes no claim and refuses with
  `STIM_CLAIM_UNAVAILABLE`; it never runs the guarded operation unprotected.
  Short synchronous transactions use core `withDirLock`, which shares that
  claim protocol at `<lock>.claims` and retains reentrant nesting and bounded
  waiting. The claim is the only lock state. Keep subprocess work outside short
  locks and protect it with a child-aware claim. Only a complete claim whose
  owner is proven gone is automatically recovered.
  Core owns the `unique-pid` dependency and process-identity implementation;
  cache packages remain usable without the CLI.
  Removing a claim set is `clearFreeClaimSet`, which takes the set's own claim
  first, so no sweep can delete a claim taken since it was surveyed. Device
  leases use a declared expiry because the holder can be an agent with no
  process. `pidExists` answers only "does a process with this pid exist"; it
  cannot answer whether a record on disk still describes its writer.
- **Cache contracts.** The cache packages must work without `Stim` installed.
  Keep their config path, cache root, cache key, and registration behavior
  aligned with the CLI. Resolution order is environment, machine config, then
  default. Update `cache-packages.test.ts` when those rules change. The published packages are `stim` and
  `@stim-cli/cache-s3`. Internal workspace ranges stay `workspace:*`; folded
  packages are private and are bundled into `stim`.
- **Source format.** Keep files under `src/`, `bin/`, and `test/` ASCII-only.
  Markdown can use Unicode.
- **SwiftPM TMPDIR.** Run `swift` children with the ambient `TMPDIR`. SwiftPM
  places every cross-process lock for its shared caches there, named after the
  protected path, and offers no separate setting, so a private `TMPDIR` lets
  concurrent builds race on the shared repository cache. `gc` cleans the
  `TemporaryDirectory.*` entries SwiftPM leaves.
- **Concurrency limits.** Every native build and every boot of an owned
  device takes a slot under caps derived from the machine; config or
  environment variables override them. Waiters queue in arrival order in claim
  files, which stay the record when no daemon runs.
- **Settings registry.** `packages/core/state/settings-registry.ts` defines
  every project and machine setting: type, layers, default, environment
  override, and sensitivity. Validation, doctor, `stim settings`, the shipped
  JSON Schema, and the guide contract tests derive from it; add a setting there
  first.
- **Machine-to-machine authentication.** Every network connection to
  stim-server, loopback TCP included, runs protocol 2's Noise handshake
  (`@stim-cli/core/noise-session`) before any request, as
  `docs/specs/2026-10-13-pluggable-transports-design.md` ("Authentication")
  specifies. A record holds the client's public key; capabilities come only from
  it. The network address, `tailscale whois` and `X-Forwarded-For` label records
  and key rate limits; they never authenticate. Pairing tokens and setup tickets
  are 32 random bytes; the server keeps only their derived `psk` and `lookup` in
  `server/secrets.json` and never writes them to setup journals, which are named
  by the derived `journal`. Clients of this machine's own user use the Unix
  socket, never a TCP connection. A Stim Desktop paired with another machine's
  server is an ordinary paired device there. The Desktop-only methods work only there; on a
  server Desktop started, only for the connection that proved the private
  bootstrap key Desktop passed to its bundled server on a pipe; the key never appears in arguments, environment or
  output, and is never passed to an external executable.
- **Build access.** stim-server's `build` capability lets another machine on the
  tailnet run its project code on this machine to build. The requesting machine
  makes a setup ticket (Stim Desktop's Add Machine flow, or `stim remote add`
  or `stim doctor --fix`, which print the command), and a person approves it by running
  `stim setup` on the worker with the ticket in `STIM_SETUP_TICKET`.
  Running setup is the worker-side approval: a person on the
  worker approves the key holding one ticket, once per capability, until one
  expiry, with a per-grant Y/n confirmation (Enter approves) in
  a terminal (`--yes` otherwise). Stim Desktop on the worker is the other
  approver: the person pastes the setup command there, and the server Desktop
  started runs the same setup in process (`desktop.setup.subscribe`), asking
  each grant through `desktop.setup.answer` instead of the terminal, and
  refuses rather than install or change a service, Stim Host or a route. Only
  the connection that proved Desktop's private bootstrap key may call either;
  another machine, a paired client, an SSH session and any other local client
  get `forbidden` on those methods. The terminal command, `--yes` included,
  approves as before. An SSH-driven run is not offered. Setup
  never enables Funnel or changes TCC. There is no pairing code for build, and
  `stim pairings grant` never grants it.
  It never comes with `read` or `control`. Build clients live in
  `server/build-clients.json`, apart from `devices.json`. The client names its
  remote machines in `remote.machines` and pins each one's stim-server key in
  `build-machines.json`; a worker that cannot prove that key is refused.
  `remote.build` places iOS simulator builds and Android emulator
  builds and macOS SwiftPM Debug builds with the placement words every
  workload shares (`local`, `auto`, `remote`, `remote-only` or one machine),
  trying the machines of `remote.machines` in that order, each only while it
  has a free slot and a load under its own `server.maxLoadPerCore`;
  every offload failure falls back to a local build unless the selection is
  `remote-only` or one machine, and no failure path
  writes the cache. An Android offload leaves keystores other than
  `debug.keystore`, and `keystore.properties`, out of the fingerprint and, unless a
  debug build's Gradle script names one, out of the sync
  (`packages/stim-cli/src/offload/signing-files.ts`); an iOS offload does the same for
  `*.p8`, `*.p12`, `*.mobileprovision` and `*.provisionprofile` that no Xcode build file names. A release variant's worker
  builds any other signing config unsigned
  (`packages/stim-cli/shim/android-worker-release.gradle`) and the client signs it
  with its `zipalign` then `apksigner` path, or refuses. An offloaded build runs
  the client's exact Stim build on the worker: the worker's stimd answers
  `job.start` by running that build's `dist/cli.mjs __job offload-build` (or
  `offload-probe` for an offer) from its engine store with a Node that meets the
  build's `engines`, fetching a published release from npm, or taking a build
  from a checkout or `stim engine use <path>`, which the client packs, only while
  `server.acceptClientBuilds` is `true`. stimd passes each Noise message of the
  connection to the job as one frame (a 4-byte big-endian length, then the
  message's type byte and body) and each frame the job writes back as one
  message, and parses neither; a closed connection ends the job's stdin, a
  dropped one keeps the job for `job.start {attach}`, and SIGTERM cancels it.
  This spawn and framing are frozen. Two machines reuse each other's completed
  React Native and SwiftPM artifacts when their builds report the same
  `STIM_BUILD_COMPAT` (`packages/stim-cli/src/engine/toolchain.ts`, in the
  `stim` package because `@stim-cli/core` is a ranged dependency). Bump it when a machine with the same value but
  the other version of a file listed in `scripts/build-compat.json` would
  build a different artifact or read a build or artifact message
  differently; a fix that makes a failing worker build succeed, or a field
  negotiated by a `hello` feature, needs no bump. `pnpm run lint` fails until
  `node scripts/build-compat.mjs --update` records the change, and the
  reviewer checks that record against this rule. The compatibility version
  never enters the local cache key. A hosted macOS session takes a build the same Mac ran for
  it, instead of an upload, only when the build client and the device-host
  client are approved for the same client key, and only bytes matching the
  client's verified bundle manifest. The worker builds each client and
  repository in its own area and Stim home under `server.workerRoot`, guarded by an ownership
  claim. Non-Android claims follow the worker process group. Android claims
  stay child-pending because Gradle daemons leave that group; cancellation
  releases them only after this repository's verified daemon identities exit.
  Unknown cleanup or a server crash retains unresolved repository and build-slot
  claims for manual inspection and recovery. stim-server evicts areas of approved
  clients unused for longer than `server.workerAreaMaxAgeDays` and, near the disk
  floor, the least recently used not used in the last 3 hours, which under the
  floor also go; it keeps each client's most recently used area and retains one
  with a live build, unfetched output, a running Gradle daemon or a held or
  unresolved claim. Under the area's claim it creates an empty record, whose name
  alone carries the repository and id because a client's build can write there,
  renames the area out of `repos/` and moves aside the short directories whose
  `.owner` names the area, then deletes outside the claim, the record last, so a
  later pass finishes a failed or interrupted deletion. Windows has no process
  groups:
  cancel stops the worker tree with `taskkill /T`; each checkout and repository's
  Gradle home live in private `windowsShortDir`s under `<SystemDrive>\sw`,
  because the NDK's ninja cannot open longer paths. The repository's daemon
  follows Gradle's idle policy after an Android build. Each build clears only
  the old generated idle-timeout override in its selected owned Gradle home.
  Cancellation drains only that repository; whole-client revocation and low
  memory retain their client-scoped cleanup. Low-memory sweeps wait until no
  offloaded build is running. Gradle stops a daemon
  whose Gradle home is deleted. `stim service` installs,
  reports and removes the worker's per-user service, a LaunchAgent on macOS,
  a systemd user unit on Linux or a scheduled task on Windows, whose action is
  Stim's supervisor because Task Scheduler does not restart an exited process,
  and, only when asked, a tailnet-only serve
  route; it never enables Funnel, never runs sudo or elevates, and never touches pairings,
  `$STIM_HOME/server` or settings. `stim service update` and
  `rollback` install a server version beside the running one under
  `~/Library/Application Support/Stim/services/<label>/versions/` on macOS or
  `~/.local/share/stim/services/<label>/versions/` on Linux or
  `%LOCALAPPDATA%\Stim\services\<label>\versions\` on Windows, keeping the
  running and the previous version, and repoint only the service's server
  script; a failed health check switches back. A Linux or Windows worker takes Android
  builds only; setup there approves `build` and refuses `device-host`, and off macOS
  stim-server refuses device-host requests and grants. A client approved for `build` or
  `device-host` can run the same update on this machine over the tailnet, and no
  other connection can. An exact npm release needs no setting; a client's own
  packages are taken only while `server.acceptClientBuilds` is `true`, its
  default being `false`.
- **Shared state reads.** `@stim-cli/core/state` owns the `$STIM_HOME` path
  layout, the state and payload types, and the readers of config, workspace
  state, ledgers, logs, and archives under `archive/`. The CLI owns every write
  to that state and imports the readers instead of parsing those files itself. The exceptions are
  stim-server's device recordings under `workspaces/<id>/recordings/`, which
  stim-server writes and prunes (it never creates a workspace directory). The CLI
  moves closed segments into `archive/` during removal under `native-run.lock`.
  stim-server never writes or prunes under `archive/` and reads archived segments
  through core's recording readers. Another exception: stim-server takes the
  workspace's native-run claim (`workspaceNativeRunClaim`) while a web share
  starts, and releases it after. The other exceptions are
  the build worker root (`server.workerRoot`, default `build-worker/`),
  with its Windows short directories, which stim-server and the builds it runs own, and the build slot
  stim-server takes under `build-slots/` for each offloaded build it runs,
  through core's `tryAcquireBuildSlotClaim`.
- **Hosted devices.** `device-host` approval is separate from read, control and
  build, and permits the client's native app code in its own hosted simulator.
  A person on the worker approves it by running `stim setup` there with
  the requesting machine's setup ticket: the key holding one ticket, once per
  capability, until one expiry, with a per-grant Y/n confirmation (Enter approves) in a terminal (`--yes`
  otherwise), or in Stim Desktop on the worker under the same rules, as Build
  access describes. An SSH-driven run is not offered. Setup never changes TCC or
  enables Funnel; the person approves normal macOS permission prompts.
  The server owns its opaque journal under `server/device-host-sessions/` and
  app receipts under `device-host/sessions/<id>/apps/`; core owns the readers. A hosted native worker
  uses a server-chosen private home under `device-host/sessions/` and the CLI's
  existing created-device ledger, ownership checks and centralized teardown.
  Parked hosted devices stay ledger-owned in their session home and are adopted
  only by the same client.
  Keep a child-aware ownership claim across native work and a claim for the
  session lifetime. Server close leaves a ready iOS or Android session ready
  and its device booted when no native work is in flight, and the next server
  resumes it only after taking its exclusive claim (a live child keeps it held)
  and the worker's `resume` verifies the exact ledger-owned, recorded, running
  device; anything unproven takes the stop path, and macOS apps always do. Serialize hosted admission, including unresolved sessions;
  ordinary local producers do not participate, so it is not a machine-wide hard
  capacity guarantee. Reconnect to the recorded attempt/session after a lost
  reply. Unknown creation, journal, owner or shutdown state refuses replacement;
  never identify a device by name or guess an empty inventory. Stop and
  revocation touch only that client's recorded owned device.
  The host's person lists and stops sessions through
  `device-host.sessions` and `device-host.sessions.stop` on Desktop's Unix
  socket connection; person-side stop uses the existing stop path.
  A session's Metro endpoint listens only on worker loopback. The worker never
  connects to the client: each accepted connection rides one idle
  `device-host.metro.link` connection the session's own client opened and
  authenticated, and the client forwards it only to its verified loopback Metro.
  Stop and revocation close the bridge, idle links and active streams. Keep the
  recorded worker port on reconnect; refuse an occupied port. Reverse ports
  (`stim ports reverse`, `device-host.reverse.set`) use the same transport and
  rules for the workspace's own servers: one worker bridge per reversed client
  port, listening only on worker loopback, never connecting to the client. A
  simulator shares the host's loopback, so its bridge listens on the same port
  number and an occupied port is refused; an emulator's bridge listens on a
  loopback port of the host's choosing and the exact owned emulator's
  `adb reverse` targets it. The client's Metro supervisor opens the links, each
  registered for one port taken from the workspace's record; the host pairs a
  link only with that port's bridge, and the client forwards it only to its own
  loopback on that port, so the host cannot name a client port. The session
  record keeps the bridge ports for resume, and parking, stop and revocation
  drop them. `device-host` approval is enough; it widens nothing else. Agent control of a
  session on a `local:` machine rides `device-host.agent.link` connections its
  own client opened and authenticated, which the client's supervisor feeds from
  a loopback port; the host serves only that client's session and still checks
  the session's agent token on every request.
  App transfer uses bounded digest chunks, including the manifest itself. The
  worker validates content, contained links, simulator platform, architecture
  and minimum OS before installing on the exact ledger-owned device. Hold the
  session's child claim across installation and launch, and reconcile a repeated
  app attempt without launching it again. Development launch remains unverified
  until the client's Metro bridge provides bundle evidence; a release launch
  needs positive native process evidence for true.
  Hosted view and input resolve only a ready session's exact private ledger-owned
  iOS device while this server holds its session claim. Track the capture helper
  as that claim's child. Give native posture input its own core child-aware claim
  and refuse restarted ownership or native work while that input is live or
  unresolved. Close capture and control before installation or
  native teardown. Wait for native input still running after disconnect or
  takeover, including termination of timed-out children. Revocation and server close end known transports even when
  the journal cannot be read or written; retain unresolved native claims.
  The host follows a session's agent-device records and sends the agent's
  actions as presence (`device-host.presence.subscribe`) only to the client that
  owns the session; the client keeps only agent participants from it.
  Hosting approval never widens ordinary workspace read or phone control.
- **Web shares.** `stim share` is the one path that enables Tailscale Funnel,
  and only in tailscale exposure. `share.exposure` is `auto` (the default:
  Funnel when the `tailscale` command is installed and logged in, else proxy),
  `tailscale` or `proxy`. Proxy mode never runs `tailscale serve` or
  `tailscale funnel`: the share listener binds `127.0.0.1` on the machine
  setting `share.port` for the user's own reverse proxy, links print under
  `share.publicUrl`, and the frame socket accepts exactly that URL's origin,
  never Host or `X-Forwarded-*`. The CLI asks this Stim home's stim-server through stimd's CLI socket
  (`net.connect`, then `share.start|stop|list`, refused on every network connection); a share
  lives only in that server's memory and always expires. Each share started
  through `share.start`, by the CLI or by Stim Desktop, is saved by stim-server
  as soon as it starts (the CLI saves it itself only when the server's reply
  lacks `saved: true`, an older server), with its URL token and passwords, in the workspace's
  `share-links.json` (mode 0600, written under the workspace state lock, removed
  with the workspace, by `share stop --forget` and once expired) so that
  `share ios|android --reuse` can start the same link again through
  `share.start`'s `token` and `expiresAt`; stim-server writes this file only
  through the CLI's own `saveShareLinkAsync` and `pauseShareLinks`, exported as
  `stim/share-links`, and an expired link is never extended or reused. A start
  of a link the file already holds with the same passwords keeps the entry's
  `auth`, `viewAuth` and `createdAt`, and the restore start does not pass
  through the saving path, so it never rewrites the expiry. Each saved entry has a `state`:
  `live` from when `share` starts or reuses it, `stopped` after a deliberate
  `share stop`, `stim stop` or reclaim of its workspace. A restart or crash
  leaves `live`, and a full stim-server (not a net thread `stim share` started) starts
  every live, unexpired entry of its home again when it starts, through
  `share.start`'s own path with the saved token or slug, passwords and expiry
  (`@stim-cli/core/state`'s `readLiveShareLinks`); one whose device is not there
  yet starts stopped, a refused one is logged and stays `live`. `share.stop`
  marks the entry stopped through the same module. A share outlives its
  device: when the device goes away on its own (frames fail, the device or hosted
  session changes or is not ready) the share shows as stopped, keeping its token,
  passwords, viewer sessions and expiry, and comes back on the slot's device when
  it is there; rows and the protocol carry no separate state for it. Only
  `share.stop` (which `stim stop`, `stim worktree remove` and Desktop's Stop
  send), expiry, the server stopping and a present, ready device that fails to
  stream for 5 minutes in a row while a viewer is attached end it, and its saved
  link is then marked stopped like a `share.stop`; viewers are told one of a few fixed
  reasons, never the raw error, which can name workspaces. `share --reuse` with no
  saved link starts a new share and warns. The server serves
  shares on a separate loopback listener, not the Noise protocol: per share
  the viewer page, the frames of its one device and, with control, input to
  that device through `ControlHub` (on a simulator, emulator or Android phone that includes
  its clipboard: a viewer's paste, and the viewer's own sync or copy of the device's text, never logged; a sync poll
  never starts a control session or keeps one alive), behind a 256-bit URL token, a generated
  password and an HttpOnly Secure SameSite=Strict session cookie. A control
  share can also have a second, view-only password (`--view-password`): login
  compares both digests, always both, with `timingSafeEqual`; the cookie stays an
  opaque token and its access (`control` or `view`) and optional name live only
  in server memory; the server drops every input from a `view` session, and a
  `view` session can be raised, never lowered, by the control password. The
  share socket also carries presence (each viewer's name and touches) from
  `ControlHub`'s pointer grab and `PresenceHub`; names are cleaned and are
  never logged or written to disk. In tailscale mode it adds one
  Funnel route, a whole Funnel port that nothing else uses, proxied to that
  listener, under an ownership claim at `server/share-route`, and removes it
  with the last share, and after a crash on the next start, only while the
  serve config still holds exactly that route. A share never starts the
  recorder or capture before a signed-in viewer connects. The viewer's
  stylesheet and its scripts are fixed bundled files served without a token
  under `/s/assets/`; they carry no share data. In proxy mode with
  `share.publicUrl` set, a stim-server installed with `stim service`
  keeps the listener bound with no share and answers every request that is not
  a live share's with the fixed not-found page (404, no share data, nothing
  kept about an ended share); a net thread `stim share` started and tailscale
  exposure never keep a listener. A workspace whose
  device is a hosted session is shared through this client's own device-host
  connection (one host frame subscription per codec for all viewers, control through
  `device-host.control.begin` and `device-host.input.*`); the worker sees only
  that ordinary view and control traffic and gains no capability. The share's
  viewers, their touches and the pointer grab stay in this machine's
  stim-server, which forwards only the touches the grab admits. The password is
  generated by default, set with `--password`, or dropped with
  `--no-password`, which leaves the URL token as the only secret;
  `--slug` puts a chosen name in the path in place of the token, so the password
  is then the only secret and it refuses `--no-password`; a slug a live share
  holds is refused, never taken over;
  `--view-password` refuses without `--control`, with `--no-password` and when
  it equals `--password`. When no
  net thread answers, `stim share` asks this home's stimd, started when none
  runs, to start one for shares (`net.ensure` with `share`: loopback only); that
  net thread ends after its last share unless Desktop, `stim pair` or
  `stim serve` asked for it meanwhile. stimd stays running while its net
  thread runs.

## Comment policy

Treat every code comment as removable. Keep a comment only when it is one of
these exceptions:

- A legal or license header.
- A non-obvious constraint from an external dependency, platform, vendor, or
  protocol. Name the external source and the concrete constraint.
- A required formatter directive such as `prettier-ignore`.
- A doc comment that defines a public API contract.
- A direct issue or RFC link for a constraint that code cannot express.

Delete narration, banners, commented-out code, workaround essays, and comments
that restate the code. Words such as `IMPORTANT`, `do not remove`, and `fine for
now` do not make a comment valid. Read the nearby code before judging a comment.
When no keep rule clearly applies, delete the comment.

Treat suppressions such as `eslint-disable`, `@ts-ignore`, and
`@ts-expect-error` as code problems. Keep a suppression only for a faulty,
pedantic, or style-only rule.

## Required invariants

### 1. Keep agent guidance current

Treat `packages/stim-cli/skill/SKILL.md` as a tiny discovery router. Its body
only tells the agent to run `stim guide agent`, or `npx stim guide agent` when
`stim` is not on PATH, and follow the version-matched instructions. Keep
operational guidance in the version-matched guides.
`guide agent` covers the normal workflow, safety, recovery actions, and topic
routing. Put transparent build optimizations and cache internals in the relevant
detailed topics, not the root agent guide. Detailed topics also own flag,
payload, setting, backend, cleanup, and remedy references. Do not add a
version check, compatibility branch, migration path, or any other failure
fallback to the static skill. Only one skill ships.

Update the affected guide topics and their contract tests when commands,
defaults, safety rules, or remedies change. Change `guide agent` when the agent's
actions, safety rules, or topic routing change. The static
skill changes only when its activation description or single routing command
changes.

When adding or changing a user-facing feature, update the affected website
pages under `website/docs/` and their command examples alongside the CLI guides.
Include a copyable agent prompt when it helps users try the feature. Keep
website behavior, flags, defaults, and limitations aligned with the implementation.

Document command invocation once in each human-facing installation entry
point. Show the no-install form, `npx stim <command>`, and the global
install, `npm install --global stim`. The static skill is only a router and
does not repeat installation instructions. Use `stim` alone in later examples.
In a document that does not explain installation, add one short note that tells
readers to replace `stim` with `npx stim` when it is not installed globally.
On the website, use synchronized Global and npx tabs with Global as the default.
Keep the full `npx` form in runnable hooks, release checks, and registry
remedies, which cannot assume a global install.

### 2. Create, boot, and delete only owned devices

Stim can create, boot, shut down, or delete only devices it created. Owned iOS
simulators are named `stim-<label> (<model> <runtime>)`; owned Android AVDs
remain `stim-<label>`. Both are recorded with `owned: true`, and every device
Stim creates is also listed in the locked `$STIM_HOME/created-devices.json`
ledger. Ownership is per Stim home. A device is this home's only when its
ledger lists it, or, for devices created before the ledger, when its config
records it in the device pool or in a project with `owned: true`. A name or an
AVD `config.ini` never proves ownership: every Stim home writes the same ones,
and a home cannot enumerate other homes; the machine list of homes
(`~/.stim/machine/homes`) lets an unscoped `gc` report them, never own their
devices or tear them down. The ownership re-check
before boot and teardown applies that rule, and `gc` only lists other `stim-*`
devices with a manual delete command. Never do any of those actions to a
user-created emulator or simulator. Keep a device record
when teardown fails so `gc` can find the device later.

Stim parks an eligible owned simulator or emulator it no longer needs instead
of deleting it, up to a per-platform configured maximum, and adopts a compatible
parked one before creating. While the disk pressure level is high or critical it
deletes instead of parking. Owned devices are disposable: the stim-daemon's
dormant stage and pressure ladder, automatic maintenance and `gc --delete`
delete the owned devices of an idle workspace, never of one that is in use,
leased, driven, locked or pinned by `maintenance.keep`. Parking keeps the device's apps and data; the pool
record names the installed app and its cache key. Parked devices are
Stim-owned and listed in the pool record. Adoption removes other third-party
apps except iOS XCUITest runners (`*.xctrunner`) and clears the adopting app's data before launch, on every adoption, and
skips the install only after verifying the installed bytes. On Android that proof is the installed
APK's size and the SHA-256 of its tail, from the v2 or v3 signing block through the end of the file,
matching the values recorded after one `apksigner verify` of the local APK; an APK without a recorded
tail, or a device that cannot answer that probe, compares the SHA-256 of the whole APK. Android adoption
matches the system image and recorded AVD creation settings and keeps the AVD
name. When an adopted emulator lacks room on `/data` for the install, trim app
caches, then wipe its user data through centralized teardown. Delete parked
devices only by eviction, adoption-time reconciliation of a listed unavailable
simulator, `gc --delete`, the stim-daemon's pressure ladder at high or critical
disk pressure, or automatic maintenance's age sweep after
`maintenance.olderThanDays`; erase them only with `gc --cache parked
--delete`. Every route uses centralized teardown and ownership revalidation.
`gc --delete` deletes parked hosted devices through their owning session home.
Park keeps a simulator that is booted when it parks it booted for
`pool.bootedGraceMinutes`, only while memory pressure is normal and a device slot
is free, and records `bootedUntil`; adoption of it still resets and verifies as
above, without the boot. The stim-daemon shuts a booted parked simulator down
through teardown at expiry, under memory pressure before any workspace's device,
and before it reclaims a workspace's device for a waiting run.
`stop` applies the same gates to the workspace's owned iOS simulator: it ends
the app and the agent-device sessions, leaves the simulator booted and assigned
to the workspace, and records a deferred shutdown in the workspace state with the
expiry. A later `ios` run uses the booted simulator and forgets the record; a
later `worktree remove` parks it booted. The stim-daemon shuts a deferred
simulator down through teardown at expiry or under memory pressure, under the
workspace's native-run lock, unless the workspace serves again. A stopped
workspace holding one is outside the idle stage until the expiry. Android
emulators are shut down by `stop`.

`stim web` launches the installed Chrome only with a profile Stim created under
`$STIM_HOME/workspaces/<id>/web/`, listed under `web` in the created-devices
ledger, and never attaches to a browser it did not start. Its supervisor holds
an ownership claim with Chrome as the claim's child. Teardown goes through
`devices/teardown.ts`, signals the supervisor or Chrome only after verifying
the recorded identity, removes Chrome's `Singleton*` lock files only once Chrome
is gone, and deletes a profile only when the ledger lists it.

A physical device reached through `android --device` or `ios --device` is
used but not owned. Hardware cannot be created or booted, so those paths
install, launch, and read what logs they can, and nothing more. The only
state a physical device leaves is its lease: the file under
`$STIM_HOME/device-locks/` and the holder's token in that workspace's
`state.json`, plus, for Android, the serial and Metro port of the `adb reverse`
the run added, recorded in that `state.json` so `stop` and `worktree remove`
remove the reverses that point at that Metro port or at a port the workspace
reversed with `ports reverse`, and nothing else on the phone. For live view and control of a leased Android phone, stim-server pushes the
scrcpy server jar to `/data/local/tmp`, runs it with `app_process` over an
`adb forward`, and removes the jar and the forward when the stream stops; it
changes no setting. A serial or UDID never enters the project registry, and
`devices/teardown.ts` never sees a physical device. `stop` and `worktree remove`
release the workspace's leases; `gc --delete` deletes only expired lease
files.

### 3. Fixed invocations; never derive commands from project scripts

Do not infer and rebuild commands from project scripts. Bare React Native hosts
Metro from the project's dependencies. Expo runs its fixed start command. iOS
and Android use fixed `xcodebuild` and Gradle arguments.

The explicit `ios|android --eas-profile <name>` path downloads a compatible
completed EAS development build instead of compiling locally. Delegate profile
resolution, fingerprinting and artifact caching to fixed EAS CLI invocations.
Coordinate downloads by EAS project and build ID. A miss prints the EAS build
command; Stim never starts a cloud build. Physical devices use the existing
lease and iOS provisioning gates. EAS device failures print EAS registration
and rebuild remedies; they never register devices or change signing accounts.
Preserve Stim device ownership, Metro and launch semantics.

The supported build selectors are `ios --scheme <name>`, `ios --configuration <name>`, and
`android --variant <name>`. `ios --device-type <name>`, `ios --runtime
<version>`, `android --system-image <id>`, and `android --device-profile <id>`
select the model and version of the owned simulator or emulator for one
invocation, overriding `ios.deviceType`, `ios.runtime`, `android.systemImage`,
and `android.deviceProfile`; a name that is not installed refuses with
`STIM_BAD_ARG` and prints the installed names.
`android --device [serial]` and
`ios --device [udid]` select a connected physical device, and take
`--wait <seconds>` or `--no-wait` for the lease on it. Non-Debug iOS
configurations and Android variants ending in `Release` skip Metro. A release
cache hit must inject the current JS into a copy of the artifact. A swap
failure must run a full build; it must never install stale JS. Android swaps
require an emitted-asset manifest match, then `zipalign` before `apksigner`.

An iOS device build is always signed, Debug included. Before Stim installs or
re-seals a device app, the signing gate reads the bundle's own
`embedded.mobileprovision` and refuses one that is missing, expired, carries
no `ProvisionedDevices` list (App Store and enterprise profiles), or does not
name the target UDID. Stim re-signs only copies it makes, with an identity
present in the keychain: the one the profile's certificate names, or the one
`ios.signingIdentity` pins. A build never passes signing flags to `xcodebuild`,
in particular never `-allowProvisioningUpdates`, because a build must not mutate
an Apple Developer account. Only `stim device provision ios` passes it, after it
lists the account changes and they are confirmed at a prompt or with `--yes`; no
other command calls it. Stim installs only onto a device it drives in this
run: an owned simulator or emulator, a physical device named by `--device`, or
the remote device `--remote` targets. Do not add distribution flows: no store
upload, no TestFlight, no over-the-air install page, no reconstruction of the
project's own delivery pipeline. Archives, `.ipa` export, store signing, and
distribution remain out of scope.

### 4. Centralize device teardown

All shutdown and deletion flows must use `src/devices/teardown.ts`, and so do park,
which is the flow that gives a simulator up without deleting it, and the erase
and wipe of an owned device's data. Re-resolve
ownership before each destructive command. Contain per-device failures so batch cleanup
can continue. `stop` shuts down devices and never deletes them; the owned iOS
simulator is shut down at the expiry of `pool.bootedGraceMinutes` or under memory
pressure when the gates in invariant 2 hold, and at once otherwise.

### 5. Redirect test state

Set `STIM_HOME` to a temporary directory in every test that reads or writes
global state. Delete the directory and environment variable after each test.
This redirects Stim state, not machine-global simulators or emulators. Never
bypass the scoped GC guard for real-tool validation. Clean up only exact devices
created by that validation, using centralized teardown and retained fixture records.

The unit suite runs in a private `TMPDIR` (`vitest.global-tmpdir.ts`) and fails
when it leaves an entry with one of the prefixes listed there. Other prefixes
are not enforced, and a child started with a hand-built `env` bypasses the
redirect. Remove every directory a test creates in `afterEach`, `afterAll` or
`onTestFinished`.

The EAS session ledger and project lock under `~/.stim/machine/eas` ignore
`STIM_HOME` so every Stim home finds billable sessions. A test that reaches
them passes a temporary `ledgerRoot`, `machineRoot`, or `easLedgerRoot`, or
points `HOME` (and `USERPROFILE` on Windows) at a temporary directory.
`vitest.setup.ts` records the real root in `STIM_TEST_GUARD_REAL_EAS_ROOT`
before any test can redirect `HOME`, and the ledger and project-lock writers
throw when they would write that root while the marker is set. Attribution is
per process, so a real `stim` run elsewhere on the machine, which carries no
marker, is unaffected.

The machine list of Stim homes, `~/.stim/machine/homes/homes.json`, follows the
same rules. A home other than `~/.stim` lists itself there when it creates a
workspace or a device; registration is best-effort bookkeeping and never fails
the command. Tests pass a temporary `root` or point `HOME` at a temporary
directory, `vitest.setup.ts` records the real root in
`STIM_TEST_GUARD_REAL_HOMES_ROOT`, and its writers throw when they would write
that root while the marker is set.

### 6. Compare canonical paths

Use `realpath` when project identity or containment depends on a path. A
symlinked worktree must resolve to the same config key as its target.

### 7. Preserve stdout contracts

`worktree warm` and `worktree remove` keep stdout empty. JSON commands print
exactly one parseable payload, except `logs --json`, which emits newline-delimited
records and stays empty when no records match, and `status --watch --json`,
which emits one complete status payload per line and never repeats an
identical one. In JSON mode, send status,
warnings, and progress to stderr. Preserve existing plain-command streams:
native build progress goes to stderr, while plain `start` also prints progress
on stdout.

### 8. Fail closed during cleanup

An absent path can belong to an unmounted volume or unresolved symlink. When the
project registry cannot prove that an entry is stale, keep the entry and its
device claim.

### 9. Verify real tool calls

Mocks do not prove that `git`, `simctl`, `adb`, `avdmanager`, `xcodebuild`, or
Gradle accepts an argument list. Exercise changed tool calls against the real
tool at least once. Use a timeout around `simctl`.

### 10. Store under the post-mutation cache key

`expo prebuild` and `pod install` can change fingerprinted inputs. Keep the
initial lookup and single-flight lock on the pre-mutation key. After a mutation,
fingerprint again and resolve once under the new key before compiling. Store
the artifact, `lastBuild`, and remote upload only under the post-mutation key.
Do not store the same artifact under both keys. A recorded fingerprint from
`$STIM_HOME/fingerprint-memo` may stand in only for the pre-mutation lookup.
The post-mutation fingerprint, the build worker and `doctor` always compute it
in full. Write a record only from a full fingerprint, never from a recorded one.
A record's key is the static digest, which leaves out the Stim version. Bump
`STATIC_SCHEMA` (`packages/stim-cli/src/cache/static-fingerprint.ts`) when the
other version of a file listed in `scripts/static-fingerprint.json` could give
a tree the same static digest but a different full fingerprint; `pnpm run lint`
fails until `node scripts/static-fingerprint.mjs --update` records the change.

### 11. Preserve launch status semantics

`launched` can be `true`, `'bundling'`, `'unverified'`, or `false`. Use `true`
only for a proven bundle request, or a live process of an app whose runtime has
no Metro (a release build, or a native Xcode or Gradle app). Use `'bundling'`
only for positive, non-error evidence from this workspace's Metro port. Use
`'unverified'` when there is no evidence. Only `'unverified'` gets launch
remedies. `false` is reserved and is not produced today.

## Releases and commits

Follow [`RELEASE.md`](./RELEASE.md) for releases. Keep one logical change per
commit. Use conventional prefixes such as `feat:`, `fix:`, `docs:`, and
`chore:`. Keep commit titles short. Do not force GPG signing.
