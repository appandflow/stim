# LLP 0028: Stim home layout

**Type:** Decision
**Status:** Active
**Systems:** Cleanup, Claims
**Author:** Claude
**Date:** 2026-11-24
**Related:** LLP 0001, LLP 0007, LLP 0009, LLP 0010

`@stim-cli/core/state` owns the path layout of `$STIM_HOME`; the CLI imports
its resolvers and owns every write. This document records the rules for
folder names in that layout that the code alone does not explain.

## Churn folders end in noindex

The folders Stim fills with regenerable churn are named `*.noindex`, on every
platform, so there is one layout:

- `$STIM_HOME/metro-cache.noindex`, the Metro transform caches;
- `$STIM_HOME/compilation-cache.noindex`, the shared Xcode compilation cache;
- `$STIM_HOME/ccache.noindex`, the shared Android ccache;
- `$STIM_HOME/workspaces/<id>/agent-device.noindex`, each workspace's
  agent-device state directory.

Config, state, ledgers and logs keep plain names and stay searchable.

Reason: macOS Spotlight indexes the Stim home. On one developer Mac it held
about 63,000 indexed files, almost all in these folders, and `mds_stores` ran
at about 240% CPU in bursts. Tested on macOS 27, Spotlight skips a folder named
`*.noindex` and everything below it. A `.metadata_never_index` or
`.metadata_never_index_unless_rootfs` marker does not stop indexing, also
when the marker is there before the files. The other ways out need per-Mac
setup or root (the Spotlight privacy list, `mdutil -i off` for a whole
volume). Xcode names its own caches the same way (`Index.noindex`,
`ModuleCache.noindex`, `CompilationCache.noindex`). The suffix changes nothing
on Linux and Windows, and one layout keeps every reader on one set of names.

Maintainer decision: "lets work on it now", 2026-11-24, in answer to whether to
file and fix renaming Stim's churn folders to `*.noindex` (#6298). The folder
list, the migration below and keeping the build worker root were chosen by the
implementing agent from the issue's fix idea.

## An existing home renames each folder once nothing holds it

Each resolver returns the `*.noindex` path once it exists, else the folder
under its old name while that exists, else the `*.noindex` path. A home made
before the rename keeps working, and no first build or dev server creates an
empty new folder beside a warm old one.

stimd renames an old folder at the start of each maintenance lane pass while
`daemon.mode` is `on`; in `report` mode the lane writes nothing, so the old
names stay and the resolvers keep serving them. The CLI renames a workspace's
agent-device directory before `stim start` reports its path, before it writes
the boot hook, and before `stim agent-device` runs there, in every mode: those
commands write the workspace's state, the boot hook among it, whatever
`daemon.mode` is. A folder moves with one `rename`, never
a copy, and only when:

- it is a real directory, not a symbolic link, and nothing exists at the new
  name; a link stays where the user put it;
- for the compilation cache and ccache: no build slot or build lock is live or
  unresolved, and the exclusive emptying claim of both names is free, the
  claim `gc` takes to empty them. Only xcodebuild claims the compilation
  cache; no build claims ccache, so the slots and locks are what show a
  Gradle build using it;
- for the Metro cache root: no workspace's `metro.claim` is live or
  unresolved, and neither `caches.metroCache` nor `STIM_METRO_CACHE` names the
  root;
- for an agent-device directory: its `daemon.json` names no daemon that may
  still run, and no `daemon.lock` exists, whatever `daemon.json` says. A
  replacement daemon takes the lock before it rewrites the record of a crashed
  one, so a lock beside a dead record can mean a daemon starting; a stale lock
  only defers the rename. A daemon keeps the old directory until it stops,
  since agent-device refuses a symlinked state directory.

After a shared cache moves, its entries in `caches.json` move with it.

The old `compilation-cache` name stays behind as a symbolic link to
`compilation-cache.noindex`. `stim doctor` tells builds outside Stim to point
`COMPILATION_CACHE_CAS_PATH` at Stim's cache, and those builds take no claim and
keep the absolute path they were given; through the link they keep sharing the
renamed cache instead of filling a cold one at the old path. Spotlight does not
index through a link. Stim treats that link as the cache's other name: the
resolver returns the `*.noindex` path, even after the folder is gone, the
migration and the leftover check skip it because it is not a real directory,
and maintenance measures the cache once, by its canonical path. Stim never
removes the link. ccache gets no link: nothing tells a build outside Stim to
use Stim's ccache directory.

Old and new names can both exist: an older Stim recreates an old folder, a
build that resolved the old path just before the rename refills it, or an
agent keeps the `AGENT_DEVICE_STATE_DIR` printed before the rename. Stim then
uses the new folder and never merges, moves or deletes the old one for being
old. Maintenance measures an old shared cache folder under its category and
trims or empties it like the cache. Every reader of workspace agent-device
state reads both names: device activity, the agent-action reader and its
follower, agent-device usage, the idle stop's session times, owned-session
close, the daemon stop and archive of workspace removal (which merges both
`sessions` folders into the archive's `agent-device/sessions`, numbering a
session name found in both instead of overwriting it; a link at either state
folder or either `sessions` folder refuses the archive before anything moves
through it, and nothing is read while `archive.agentActions.maxAgeDays` is 0),
and gc's leftover check. `stim agent-device` reads only the directory it hands
agent-device for that run.

## Rolling back past this layout

The rename is one-way. An engine from before it, reached with `stim engine
rollback` or an older install on the same home, knows only the old names:

- it creates and fills `metro-cache`, `compilation-cache` and `ccache` again,
  so its builds and dev servers start cold;
- its gc and maintenance neither measure nor trim the `*.noindex` folders;
- its `worktree remove` and reclaim look for a daemon only in
  `agent-device/daemon.json`, so they can empty a workspace while a daemon
  still runs in `agent-device.noindex`, and they archive only the old
  `sessions` folder.

This is a known limitation of rolling back past this release; going forward
again finds both names and uses the new ones, as above.

Reason: a rename under a running dev server, build or daemon sends its writes
to a new copy of the old path, and a copy-then-delete of a multi-GB cache could
lose it half way. Waiting for a free moment costs nothing but time.

## The build worker root keeps its name

`server.workerRoot` keeps its default, `$STIM_HOME/build-worker`, and Stim never
moves a worker root.

Reason: stim-server and its builds own that tree outside stimd's claims, build
slots and areas are keyed on its path, Windows short directories are keyed on
the hashed path (`windowsShortDirKey`), and the checkouts bake absolute paths
into Pods, CMake and DerivedData, so renaming it is not a pure move. A worker
owner who wants it out of Spotlight sets `server.workerRoot` to a `*.noindex`
path before the worker takes builds.

## Links

- Issue: #6298.
- Code: `packages/core/index.ts` (`noindexDir`, `metroCacheRoot`),
  `packages/core/state/paths.ts` (`sharedNoindexCaches`, `workspaceAgentDeviceDir`,
  `agentDeviceStateDirsIn`), `packages/stim-cli/src/workspace/noindex-folders.ts`,
  `packages/stim-cli/src/daemon/passes.ts` (`createMaintenanceLane`).
