# LLP 0023: The public API of the stim package

**Type:** Decision
**Status:** Active
**Systems:** Repo, Engine, Transport
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12

This document follows the coordinator's review of
[#5592](https://github.com/appandflow/stim/issues/5592#issuecomment-6836925220).
The maintainer decided only that 2.0 is a breaking release. The rest is the
review's proposal as implemented and reviewed, not a maintainer decision.

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
from the same package. They carry no compatibility. A doc comment that starts
with `@internal` marks a member that serves Stim Desktop or stim-server, such
as `deviceTool()` or the `admission` option, and it may change in any release.

`runOp` stays exported from the package root and is marked `@internal`: another
Stim build imports `dist/api.mjs` and looks `runOp` up by name to route an
operation to this build. Removing it would make an older client run the
operation in its own build against a newer engine's home. The operation and
option names `runOp` receives (`EngineClient`, `EngineOptions`) keep the names
they had when builds started routing to each other, and the `createStim` facade
translates the public names (`previewGarbage`, `buildCacheDir`, `waitSeconds`,
`errorsOnly`) to them.

## Frozen and experimental plugin kinds

Only the `cache-provider` contract is stable in 2.x. The `transport` and
`agent-driver` kinds are experimental: they are built in only, their shapes
expose host internals (the claim protocol, Tailscale terms), and their
contracts and integers may change in a minor release. `stim/plugin` exports only
what a plugin implements or tests with.

## JSON payloads

Within 2.x a `--json` payload, a `logs --json` record and an API result only
gain fields and enum values. `website/docs/commands.md` ("JSON stability within
2.x") names the parts that carry no compatibility: `status --json`'s
`maintenance` and `daemon` objects and its idle, dormant and tutorial records,
`gitChip`, `agentDevice.stateDir`, and paths and pids of Stim's own state.

## The gate

`scripts/plugin-api-report.mjs` freezes `stim/plugin` (`plugin.api.txt`) and
the package root (`api.api.txt`). A removed or changed line needs the integer
of the kind that owns it bumped and named under `## Removed (breaking)` in the
release notes: a plugin kind's `*_API_VERSION`, or `STIM_API_VERSION` for the
package root. A new required member of an interface a plugin implements
(`CacheProvider`, `CacheProviderModule`, `BuildCacheCapability`,
`FileCacheCapability`, `Transport`, `TransportModule`, `HostedAgentDriver`,
`AgentDriverModule`) is breaking too, because every plugin built before it lacks
it. A line tagged `@internal` changes without a bump. Before 2.0.0 the reports
were reset once instead of bumped, so every integer stays 1 at 2.0.0.
