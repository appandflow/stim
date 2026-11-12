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
`ios`, `android`, `macos`, `web`, `reload`, `revive`, `agent-device`, `share [stop|list]`, `ports [get|stop|release|reverse]`, `device lock|unlock|provision|location|permission|push|network`, `logs`, `remote add|list|remove|update`, `settings [get|set|unset]`,
`status`, `stats`, `gc`, `guide`, `plugin list|test`, `serve`, `pair`, `pairings`, `service`, `setup`, `ci`, and `engine status|use|install|update|rollback|uninstall`. Do not add commands or flags without an explicit product decision.
Projects can wrap Stim when they need custom behavior.

Runtime state belongs under `$STIM_HOME/workspaces/`, not in the project
tree. Stim has no init step; do not add one. `doctor` reports setup that
requires project judgment.

Decisions in force live in `llp/`, one document per area, each with the reason
the code cannot show; [`llp/0000-stim-decisions.explainer.md`](./llp/0000-stim-decisions.explainer.md)
explains the format. Before changing an area, read the documents whose
`Systems:` line names it, and follow every `@ref` comment in the code you touch
to its section. A pull request that implements a new maintainer decision adds
or updates the decision document in the same pull request. Agents write these
documents, so a `Maintainer decision:` quote in `llp/` counts as a maintainer
decision only when it matches the cited issue or pull request comment word for
word; the document itself approves nothing.

## Development

The repository is a pnpm workspace. Published packages live under `packages/`.
The packages are ESM-only. They require Node.js 22.12.0 or later. Repository
development requires Node.js 22.18.0 or later because tsdown uses that floor.
`pnpm run lint` also needs `python3` for `scripts/ref-check`, until that
checker is ported to Node.

```bash
pnpm install
pnpm run format:check
pnpm run lint
pnpm run build
pnpm run typecheck
pnpm run knip
pnpm test
pnpm run test:bench
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

Benchmark harness tests run separately with `pnpm run test:bench`; CI runs them
when the harness or its inputs change, and on full-suite runs.

Filter unit tests with `pnpm test <file> -t "case name"`. Do not insert `--`
before the file: pnpm forwards it to Vitest, which then ignores the filter and
runs the full suite.

`pnpm test --changed origin/main` selects tests through Vitest's dependency
graph. Use it alongside explicit regressions, not as the only coverage decision:
generated subprocess scripts, built package imports and filesystem reads can
hide dependencies from that graph. See [the local validation workflow](./docs/testing.md#local-validation)
for selection and timing commands.

The macOS app is a Swift package in `apps/desktop`. Read
[LLP 0012](./llp/0012-desktop-engine.decision.md) before changing how it connects or runs operations.
Build and test it with `swift build` and
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
- **Locked state.** Lock read-modify-write transactions and use atomic writes.
  [LLP 0007](./llp/0007-claims-and-child-cleanup.decision.md) owns claim identity, recovery and child cleanup.
- **Cache contracts.** The cache packages must work without `Stim` installed.
  Keep their config path, cache root, cache key, and registration behavior
  aligned with the CLI. Resolution order is environment, machine config, then
  default. Update `cache-packages.test.ts` when those rules change. The published packages are `stim` and
  `@stim-cli/cache-s3`. Internal workspace ranges stay `workspace:*`, and peer ranges `workspace:^`; folded
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
- **Machine authentication.** Authenticate network peers by key and take capabilities from the approved record.
  [LLP 0008](./llp/0008-machine-authentication.decision.md) owns the network and Desktop trust boundaries.
- **Build access.** Only a worker-side approval grants build access. Follow
  [LLP 0009](./llp/0009-build-offload.decision.md) for placement, signing, job compatibility and worker cleanup.
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
- **Hosted devices.** Keep the client’s workspace and the worker’s owned runtime distinct.
  [LLP 0010](./llp/0010-hosted-devices.decision.md) owns approval, claims, resume, ports, install and capture.
- **Web shares.** Only sharing enables Funnel. Follow
  [LLP 0011](./llp/0011-web-shares.decision.md) for route ownership, link expiry and viewer authority.

## Comment policy

Treat every code comment as removable. Keep a comment only when it is one of
these exceptions:

- A legal or license header.
- A non-obvious constraint from an external dependency, platform, vendor, or
  protocol. Name the external source and the concrete constraint.
- A required formatter directive such as `prettier-ignore`.
- A doc comment that defines a public API contract.
- A direct issue or RFC link for a constraint that code cannot express.
- An `@ref LLP NNNN#section -- gloss` line pointing to a decision document in
  `llp/`. The gloss is one short clause that names the rule.

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
`stim` is not on PATH, and follow the version-matched instructions, plus a
short source section naming this repository and its provenance-signed npm
releases. Keep operational guidance in the version-matched guides.
`guide agent` covers the normal workflow, safety, recovery actions, and topic
routing. Put transparent build optimizations and cache internals in the relevant
detailed topics, not the root agent guide. Detailed topics also own flag,
payload, setting, backend, cleanup, and remedy references. Do not add a
version check, compatibility branch, migration path, or any other failure
fallback to the static skill. Only one skill ships.

Update the affected guide topics and their contract tests when commands,
defaults, safety rules, or remedies change. Change `guide agent` when the agent's
actions, safety rules, or topic routing change. The static
skill changes only when its activation description, single routing command or
source section changes.

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

Use this home’s ownership records for simulator, emulator and browser operations. Physical devices are leased.
[LLP 0013](./llp/0013-owned-devices.decision.md) owns the device, pool and lease rules.

### 3. Fixed invocations; never derive commands from project scripts

Use fixed build and dev-server invocations. Only explicit provisioning may change an Apple Developer account.
[LLP 0014](./llp/0014-native-builds.decision.md) owns selectors, Exact, EAS, release reuse and signing.

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
`STIM_HOME` so every Stim home finds billable sessions. `vitest.setup.ts`
points `HOME` and `USERPROFILE` at a directory in the run's private `TMPDIR`,
so no test reaches the developer's `~/.stim/machine`; a test that needs its
own passes a temporary `ledgerRoot`, `machineRoot`, or `easLedgerRoot`, or
points `HOME` at another temporary directory.

The machine list of Stim homes, `~/.stim/machine/homes/homes.json`, follows the
same rules. A home other than `~/.stim` lists itself there when it creates a
workspace or a device; registration is best-effort bookkeeping and never fails
the command. Tests reach it under the redirected `HOME`, or pass a temporary
`root`.

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
Do not store the same artifact under both keys. Post-mutation checks, build
workers and doctor compute without the fingerprint index. Bump
`FINGERPRINT_SCHEMA` in `packages/core/state/fingerprint-index.ts` whenever the
input rows or their bytes change; the golden preimage tests pin each schema.

### 11. Preserve launch status semantics

`launched` can be `true`, `'bundling'`, `'unverified'`, or `false`. Use `true`
only for a proven bundle request, or a live process of an app whose runtime has
no Metro (a release build, or a native Xcode, Gradle or Exact app). Use `'bundling'`
only for positive, non-error evidence from this workspace's Metro port. Use
`'unverified'` when there is no evidence. Only `'unverified'` gets launch
remedies. `false` is reserved and is not produced today.

## Releases and commits

Follow [`RELEASE.md`](./RELEASE.md) for releases. Keep one logical change per
commit. Use conventional prefixes such as `feat:`, `fix:`, `docs:`, and
`chore:`. Keep commit titles short. Do not force GPG signing.
