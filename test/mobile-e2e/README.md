# tester.army mobile pilot

Issue [#2343](https://github.com/appandflow/stim/issues/2343) evaluates two
mock-mobile flows before adopting a new framework. This private package is
outside the pnpm workspace and changes no app dependency, native module or CI
workflow. Root knip checks its declared dependencies; UI/model runs remain optional. It uses `e2e` 0.17.0, `@e2e-dev/mobile` 0.9.2 (agent-device 0.21.20)
and AI SDK 7.0.27. Use Node 24.8 or newer; the pilot was collected on 24.19.0.
The AI SDK is e2e's runtime peer for optional model navigation. Root knip permits
that peer and the separately installed `e2e` command when the pilot SDK is absent.
The mobile engine's agent-device dependency does not replace the shared CLI at
`~/.local/bin/agent-device`.

## Fixture setup

Commands use `stim`; replace it with `npx stim` when it is not installed globally.
Install globally with `npm install --global stim`, or use the no-install form
`npx stim status --json`.

Use the regular Stim home, with `STIM_HOME` unset. Select a retained, explicitly
owned development fixture, coordinate its use and check disk/memory headroom.
Do not allocate a new device or start a cold native build for this pilot. A
closed Duo cover is compact; this slice does not change posture or validate the
wide split. Keep original dogfood simulators and user apps untouched.

Run from the selected fixture's `apps/mobile` directory. For this app, use
`APP_VARIANT=development stim ios --plan` to check the development-client cache.
Carry `APP_VARIANT=development` into `stim start` and `stim ios`; the app config
defaults to the production bundle ID otherwise. Start/launch only when resource gates permit it, using
that workspace's existing slot and normal Stim viewer. Confirm the exact UDID,
`com.appandflow.stim.dev`, bundle delivery and `stim logs --errors` before use.
The tester.army runner does not build, install, start Metro, change permissions
or clear app data. Its engine may prepare its own automation runner on the
selected simulator.

Start the existing mock server with only its `a4-*` workspaces:

```sh
pnpm run mock-server --port 7799 --name "Pilot Mock" --workspaces a4-
pnpm run dev:pair --mock --port 7799
```

Use only fresh mock credentials on this fixture. Back up and restore the
fixture's own development environment/state privately; never copy production
pairings or model secrets. Set English locale and select Workspaces with home
filters clear. The mock's initial notification history starts read; a new
entry arrives every two minutes. Tests wait on that actual unread row rather
than assume seed history is unread.

## Collect and run

Install this standalone package with pnpm's workspace isolation:

```sh
cd test/mobile-e2e
pnpm install --ignore-workspace --ignore-scripts
export PILOT_WORKSPACE=/absolute/path/to/retained/fixture/apps/mobile
export PILOT_SLOT=the-existing-slot
export PILOT_UDID=the-exact-Stim-owned-UDID
export PILOT_METRO_PORT=the-port-reported-by-Stim
E2E_TELEMETRY_DISABLED=1 pnpm --ignore-workspace run list
pnpm --ignore-workspace test --output .e2e/baseline-1
```

In a linked worktree, complete `stim worktree warm` before installing; review
its copy exclusions so no local secrets are copied. The preparation run used
a separate temporary package instead of warming or installing the app.
`list` collects without an engine/app/worker. `pnpm --ignore-workspace test` checks Stim status
and refuses unless that exact owned fixture is already booted, its app is
running and its Metro is live. Use this guarded entry point for runs; direct
`e2e run` bypasses the pilot's ownership check. Nothing in the pilot boots a
shutdown fixture on purpose.

The default mode uses exact interactions and deterministic assertions. It
opens the compact menu, opens and closes Pair, checks the drawer remained
visible at the same bounds, pushes `a4-running` and returns with Back. The
inbox flow verifies both sample categories first, excludes the started row
when filtering to stuck, restores all categories, waits for a fresh unread
entry and verifies Mark all read removes the unread prefix while rows remain.
Native roles, menu ordering and these candidate locators still need live
fixture acceptance; collection alone does not establish UI correctness.
Once the fixture is available, repeat the deterministic baseline three times
with separate outputs (`baseline-1` through `baseline-3`) and no retries.
Record actual failures and duration before enabling AI actions.

## AI and cache evaluation

Use an explicitly authorized subscription/provider or local model. The pilot
does not inspect credential stores, sign in, or choose a paid account.
Create ignored `model.local.mjs` exporting a tester.army agent object with a
`model` that supports tools and images, following the official
[model setup](https://e2e.tester.army/docs/models). Keep authentication outside
source. Setting `PILOT_AI=1` replaces the exact interactions with `agent.act`
goals; every goal still ends with a deterministic locator assertion. It imports
only that explicit local module and caps each goal at eight model calls.

After baseline acceptance, start with an empty pilot cache and record one cold
run with cache writes enabled, then five cached runs, with no retries. Keep the
cache between them:

```sh
PILOT_AI=1 pnpm --ignore-workspace test --output .e2e/cold
PILOT_AI=1 pnpm --ignore-workspace test --output .e2e/cached-1
```

Repeat the second command with `cached-2` through `cached-5`. Retain each
`report.json` and `summary.md`: duration, failures, model calls/tokens/cost and
`step.cache.mode`/reason distinguish replay, miss and hand-off. Provider cost
that the report cannot price is unavailable, not zero. `agent.assert`,
`agent.waitFor` and `agent.extract` would always call the model; these two
flows use deterministic assertions to verify action recordings. See
[cache semantics](https://e2e.tester.army/docs/cache).

## Intentional regression

On only the disposable fixture source, temporarily replace the inbox category
menu's `onPress={() => setCategory(value)}` with `onPress={() => setCategory(null)}`.
The source is `apps/mobile/src/screens/inbox.tsx`; retain its original bytes
and SHA-256 privately before the change. Run only the notification flow:

```sh
pnpm --ignore-workspace test --grep '^notification category' --output .e2e/intentional-regression
```

The stuck filter must fail because the started row remains. Retain the failing
report/screenshot, restore the original bytes and verify their hash, then rerun
the same selection with `--output .e2e/restored-regression` successfully. Do not
weaken the assertion, use an expected failure, or count a configuration refusal
as this proof.

After runs, restore fixture source, environment, selected home section, filters
and posture; close the exact automation session and stop the exact Stim slot.
Retain device apps/data and never delete a device for this pilot.

## Current result

Recommendation: **limit to this pilot; adoption is undecided**. Local package
installation and collection of exactly two tests passed. UI reliability,
intentional filter regression, cold-model cost and cached replay are
**unavailable**: the retained Duo was below its 24 GiB disk gate, and no model
account was authorized. No healthy fixture is allocated. The retained development Duo is shut down
with Metro stopped. The ordinary-phone candidate has a production client and a
cold-build plan. No UI/model run, device boot or app mutation
is claimed. Harness preparation alone does not complete the pilot's acceptance.

The next validation gate is an explicit allocation of an existing owned phone
with sufficient disk/memory headroom and a verified native cache hit. Launch it
through regular Stim, verify the exact slot/UDID, live Metro and running Stim
Dev app, then accept the candidate native locators and record three baseline
runs plus the failing-and-restored filter regression. A separate explicitly
authorized model configuration is required for the cold run and five cached
runs. Neither gate is satisfied by collection or by the launch guard refusing.
