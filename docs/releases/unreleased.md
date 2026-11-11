# Unreleased

## Added

- `stim plugin list` lists the bundled plugins and the plugin `cache.provider` names, and `stim plugin test <plugin>` runs a transport or agent-driver plugin's contract kit with the module in a worker thread. `stim doctor` and `stim settings set cache.provider` now report a cache provider that does not resolve or declares another integer.
- `stim remote update <mac>` updates an approved worker to the newest compatible release on its channel. Use `--channel next` to select prereleases for one update.

## Changed

- `import('stim')` loads a small `createStim` facade, and Stim's implementation loads on the first operation call. Every client operation now reports a refusal as a rejected promise, including the argument checks that threw synchronously before.
- Stim computes its own native build-cache fingerprint. Older cache entries miss once. For a generated Expo native directory with an older fingerprint record, preserve any changes, move or remove that generated directory, and retry. `stim doctor` runs project config and autolinking in an isolated child to check fingerprint determinism and worktree parity; run it only in a checkout whose project code you trust. The worker wire protocol is now peer 3 and build compatibility is 6; update an older worker before offloading.
- The private fingerprint replay record keeps `STIM_HOME` and `STIM_RUN_ID`, without sending them as fingerprint inputs to a worker. An embedded-config or dependency read of a private Stim credential, or project environment enumeration while one is present, makes the build uncached; remove the credential from the build environment to retry caching.
- Offloaded builds remove Stim's own access and setup credentials from the worker's build environment. Project build tools can still print the environment values they receive.
