# LLP 0023: The public API of the stim package

**Type:** Decision
**Status:** Active
**Systems:** Repo, Engine, Transport
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12

This document follows the review of
[#5592](https://github.com/appandflow/stim/issues/5592#issuecomment-6836925220)
and the coordinating session's reviews of #5613 and #5628. The maintainer
decided only that 2.0 is a breaking release. The rules below are the review's
proposals and the coordinator's decisions as implemented; none is a maintainer
decision, and the list at the end names the choices that wait for one.

## Public entries

These entries of the `stim` package are public:

- the package root `stim` (`createStim`, `StimError`, the `Stim*` types and
  `STIM_API_VERSION`);
- `stim/plugin`, for plugins;
- `stim/ci` and `stim/ci/artifacts`;
- `stim/cache-manifest`, which exports only `register`, `unregister` and
  `CacheEntry`.

`stim/internal/*` exists because tsdown keeps `stim/` imports external
(`neverBundle`), so the bundled stim-server and CI runner import those entries
from the same package. They carry no compatibility. `stim/internal/api-self`
exports `createLocalStim`, so an editor's auto-import never offers a second
`createStim` that skips engine routing.

A doc comment that starts with `@internal` marks a declaration or member that
serves Stim Desktop or stim-server, such as `deviceTool()` or the `admission`
option; it may change in any release. So may every type that only such
members reach.

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
above 0. `diagnostics`' `errors` is `errorsOnly`, as `logs()` names it.
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
what a plugin implements or tests with.

## JSON payloads

Within 2.x a `--json` payload, a `logs --json` record and an API result only
gain fields and enum values. `website/docs/commands.md` ("JSON stability within
2.x") names the parts that carry no compatibility.

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
- A line tagged `@internal`, or of a declaration only `@internal` members
  reach, changes without a bump; the baseline is still refreshed.
- A pull request and the merge queue also compare the reports with the base
  branch's baselines, so a hand-edited baseline fails.

The reports were reset once, in #5613, with `--reset`. A reset is allowed only
while `.github/next-version` names the next major, and only against a base whose
baseline does not already record one, so it cannot recur after 2.0.0 or in a
later pull request. #5628, stacked on #5613, bumps `STIM_API_VERSION` to 2
instead of resetting again.

## Choices for the maintainer

1. `gc()` renamed to `previewGarbage()` (see above).
2. `buildCacheDir`, `waitSeconds` (`false` also bypasses another workspace's
   physical-device lease, as `--no-wait` does) and `errorsOnly`.
3. `STIM_API_VERSION`, starting at 1 and at 2 when 2.0.0 ships, and
   `RUN_OP_VERSION`.
4. The `stim/internal/*` entries, the `@internal` members and the types no
   longer exported (`StimDeviceToolOptions`, `StimGcItem`,
   `StimGcItemOptions`, `StimGcItemResult`, `StimMachineAccessOptions`).
5. `stim/plugin` reduced to an explicit list, including the removal of
   `cacheProviderContractChecks`, and `loadCacheProvider` kept in it.
6. The `transport` and `agent-driver` kinds declared experimental.
7. `@stim-cli/cache-s3`'s peer range `^<version>` rather than `^2.0.0`: a
   `^2.0.0` range excludes the `2.0.0-next` prereleases the `next` channel
   publishes, so it would warn on every prerelease install.
8. Left as they are: `ok` versus `exitCode` in results, `simulatorApp?: string`
   and `remote?: string` on run, the run and build facts differences (review
   item 1.8), `CacheProviderModule.apiVersion`, which the loader never reads,
   and the `before*` hooks, which stay public.
