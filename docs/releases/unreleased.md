# Unreleased

## Added

- `stim plugin list` lists the bundled plugins and the plugin `cache.provider` names, and `stim plugin test <plugin>` runs a transport or agent-driver plugin's contract kit with the module in a worker thread. `stim doctor` and `stim settings set cache.provider` now report a cache provider that does not resolve or declares another integer.
- `stim remote update <mac>` updates an approved worker to the newest compatible release on its channel. Use `--channel next` to select prereleases for one update.

## Removed (breaking)

- `stim gc` runs one automatic maintenance pass at the measured pressure level and deletes; `--dry-run` reports instead, and `--pressure <normal|high|critical>` sets the level. `--delete`, `--cache`, `--older-than` and `--worktrees` are gone. The API's `gc()` and `collectGarbage()` take `{ pressure }` instead of `{ olderThan, cache, worktrees, delete }`, and the payload is the level run (`level`, `actions`, `blocked`, `results`, plus the storage sections on a dry run). Stim Desktop deletes a single item through stim-server, and the API exposes it as `deleteGarbageItem({ item })`.
- `idle.dormantDays` defaults to 1. A workspace idle that long is reduced to its minimal size at every level, including a linked worktree's `node_modules` and Pods when `worktree warm` cannot restore the same versions; the next Stim command asks for an install then. gc deletes unused iOS simulator runtimes, and at critical, while the disk is still short, cleans the npm, Yarn, pnpm, CocoaPods, Gradle and SwiftPM caches, through their own commands where they have one. The ladder deletes `node_modules` and Pods of linked worktrees idle 1 hour at high. `stim worktree remove` parks devices unless the disk level is critical. Defaults change: `disk.criticalFreeGb` 6 to 20 and `disk.minFreeGb` 20 to 40.

## Changed

- `import('stim')` loads a small `createStim` facade, and Stim's implementation loads on the first operation call. Every client operation now reports a refusal as a rejected promise, including the argument checks that threw synchronously before.
- `stim ci --version` and `stim ci -V` print the CI package version after Stim's pre-command checks run. Under `stim-server`, an option after a subcommand that the subcommand does not define, such as `stim-server devices grant ID --json`, is refused.
- Stim computes its own native build-cache fingerprint. Older cache entries miss once. For a generated Expo native directory with an older fingerprint record, preserve any changes, move or remove that generated directory, and retry. `stim doctor` runs project config and autolinking in an isolated child to check fingerprint determinism and worktree parity; run it only in a checkout whose project code you trust. The worker wire protocol is now peer 3 and build compatibility is 6; update an older worker before offloading.
- The private fingerprint replay record keeps `STIM_HOME` and `STIM_RUN_ID`, without sending them as fingerprint inputs to a worker. An embedded-config or dependency read of a private Stim credential, or project environment enumeration while one is present, makes the build uncached; remove the credential from the build environment to retry caching.
- Offloaded builds remove Stim's own access and setup credentials from the worker's build environment. Project build tools can still print the environment values they receive.
