# LLP 0023: The public API of the stim package

**Type:** Decision
**Status:** Active
**Systems:** Repo, Engine, Transport
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12

This document follows the public API review in
[#5592](https://github.com/appandflow/stim/issues/5592#issuecomment-6836925220)
and the implementation in [#5613](https://github.com/appandflow/stim/pull/5613),
which includes #5628. The maintainer confirmed the 2.0 choices in
[#5685](https://github.com/appandflow/stim/issues/5685) and
[#5592](https://github.com/appandflow/stim/issues/5592#issuecomment-6864811267).
The other provisions record the review and the coordinator's implementation decisions.

## Public entries

These entries of the `stim` package are public:

- the package root `stim` (`createStim`, `StimError`, the `Stim*` types and
  `STIM_API_VERSION`);
- `stim/plugin`, for plugins;
- `stim/ci` and `stim/ci/artifacts`;
- `stim/cache-manifest`, which exports `register(entry)`, `unregister(dir)`
  and `CacheEntry`. Stim chooses the manifest path.

`stim/internal/*` exists because tsdown keeps `stim/` imports external
(`neverBundle`), so the bundled stim-server and CI runner import those entries
from the same package. They carry no compatibility. `stim/internal/api-self`
exports `createLocalStim`, so an editor's auto-import never offers a second
`createStim` that skips engine routing.

A doc comment that starts with `@internal` marks a declaration or member that
serves Stim Desktop or stim-server, such as `deviceTool()` or the `admission`
option; it may change in any release. So may every type that only such
members reach. `StimDeviceToolOptions`, `StimGcItem`, `StimGcItemOptions`,
`StimGcItemResult` and `StimMachineAccessOptions` have no named public export.
The public `before*` hooks remain available, and the run selectors `simulatorApp`
and `remote` remain optional strings.

## Routing between builds

`createStim` runs an operation in the machine engine's build by importing that
build's `dist/api.mjs` and calling `runOp`, so `runOp` stays exported from the
package root, marked `@internal`. The operation and option names `runOp`
receives (`EngineClient`, `EngineOptions`) keep the names they had when builds
started routing to each other, and the facade translates the public names
(`previewGarbage`, `buildCacheDir`, `waitSeconds`, `errorsOnly`) to them.
`RUN_OP_VERSION` is that wire's integer (RELEASE rule 3). A build that loads an
engine speaking another integer refuses with `STIM_ENGINE_UNAVAILABLE`, naming
`stim engine update`; an engine without the constant speaks 1.

## Renamed names

`StimOptions.buildCache` is `buildCacheDir`, because run and build options have
a `buildCache` boolean that turns the cache on or off. Run's `wait` is
`waitSeconds`, the name `start` already used, and both take a whole number
above 0. For iOS and Android runs, `waitSeconds: false` skips waiting for an
owned-device slot or a physical device lease, like `--no-wait`.
`diagnostics`' `errors` is `errorsOnly`, as `logs()` names it.
`stim/ci`'s `buildCache` is `buildCacheDir`.

`gc()` is `previewGarbage()`. The method always previewed, so RELEASE rule 5
("an unchanged meaning keeps its name") would keep it, but the API names its
methods after the commands they run: `collectGarbage()` runs `stim gc`, which
deletes since #5514. A method named `gc` that never deletes reads as that
command.

Until 2026-12-12 (`scripts/compat-budget.json` row C33), each old name refuses
with `STIM_BAD_ARG` and names the new one; passing old and new together
refuses too.

## Frozen and experimental plugin kinds

Only the `cache-provider` contract is stable in 2.x. The `transport` and
`agent-driver` kinds are experimental: they are built in only, their shapes
expose host internals (the claim protocol, Tailscale terms), and their
contracts and integers may change in a minor release. `stim/plugin` exports only
what a plugin implements or tests with, including `loadCacheProvider` and the
contract test kits. The export list drops `cacheProviderContractChecks`.
`CacheProviderModule.apiVersion` is required, and
`BuildCacheCapability.resolve` and `BuildCacheCapability.store` return promises.
The `@stim-cli/cache-s3` peer range tracks the published Stim version so the
`next` channel's 2.0 prereleases satisfy it.

## JSON payloads

Within 2.x a `--json` payload, a `logs --json` record and an API result only
gain fields and enum values. `website/docs/commands.md` ("JSON stability within
2.x") names the parts that carry no compatibility. Results keep their current
`exitCode` or `ok` fields and their platform-specific run and build facts.
Keep the current settings and flags for 2.0. Normalize run and build JSON
only with coordinated Desktop and CI decoder updates, subject to the JSON
compatibility rules.

## The gate

`scripts/plugin-api-report.mjs` freezes `stim/plugin` (`plugin.api.txt`), the
package root (`api.api.txt`), `stim/ci` (`ci.api.txt`) and
`stim/cache-manifest` (`cache-manifest.api.txt`). Each line names its
declaration and union branch, and whether it sits in a parameter list.

- A removed or changed line needs the integer of the kind that owns it bumped,
  and named as `<kind> <integer>` under `## Removed (breaking)` in the release
  notes: a plugin kind's `*_API_VERSION`, or `STIM_API_VERSION` for the
  package root, `stim/ci` and `stim/cache-manifest`.
- A new required member breaks when the other side builds the object: what an
  interface a plugin implements returns to Stim (`CacheProvider`,
  `CacheProviderModule`, `BuildCacheCapability`, `FileCacheCapability`,
  `Transport`, `TransportModule`, `HostedAgentDriver`, `AgentDriverModule`,
  and the types they return), or what a caller passes to an exported function
  or a `StimClient` method, and the types those reach.
- An added optional parameter, a wider union and a new enum value are
  additive, as the JSON rule says. A narrower one breaks.
- A wider union in a type Stim builds and hands to a plugin breaks, because
  an existing plugin never handled the new value.
- Grouping parentheses in a type, as in `type StimBuildOptions = ((A & {`, are
  not a parameter list, so members inside them are checked like any other.
- A line tagged `@internal`, or of a declaration only `@internal` members
  reach, changes without a bump; the baseline is still refreshed. One
  `@internal` half of a merged interface does not exempt the public half.
- A pull request and the merge queue also compare the reports with the base
  branch's baselines, so a hand-edited baseline fails.

A known limit: the gate reads a `(` that ends a line as grouping, because
nothing follows it on that line. A callback parameter list split over lines
(`onProgress?: (` then `event: StimProgress`) is then not marked as parameters,
so adding a parameter to it reads as a new required member and asks for a bump.
This errs toward a bump, and no such line is in the reports today.

The reports were reset once, in #5613, with `--reset`, so every integer is 1
at 2.0.0. The base comparison accepts a reset only when the base's own
`.github/next-version` names a later major than the base's packages carry,
and the base's baseline does not already record one. A baseline that drops the
base's reset header fails. Read from the base, these files cannot be edited by
the pull request that resets, so a reset cannot recur after 2.0.0 or in a
later pull request.

## Provenance

The maintainer said "Keep new names" on 2026-11-13 for `buildCacheDir`,
`waitSeconds`, `errorsOnly` and `previewGarbage`.
[Rename decision](https://github.com/appandflow/stim/issues/5685#issuecomment-6857364673).

On 2026-11-13 the maintainer answered "yes" to keeping the cache provider
contract and both `exitCode` and `ok`.
[Contract decision](https://github.com/appandflow/stim/issues/5685#issuecomment-6862867536).

The maintainer recorded the remaining 2.0 decisions on 2026-11-13.

> keep the current settings and flags for 2.0. Normalize run/build JSON only if
> Desktop and CI can ship their decoder changes together. The API renames and
> cache provider contract already decided in #5685 stand.

[Settings, flags, and JSON decision](https://github.com/appandflow/stim/issues/5592#issuecomment-6864811267).

The API review proposed removing the unused optional
`SettingsPayload.unknown[].replacement` during the one-time reset. The field
remains in the public `StimSettings` declarations and API report. Its removal
is deferred to a future versioned API change under the gate above.
[Review note](https://github.com/appandflow/stim/issues/5592#issuecomment-6842811722),
[public API report](../packages/stim-cli/api.api.txt).
