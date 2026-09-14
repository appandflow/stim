# @stim-cli/core

Shared internal contracts for Stim and its cache packages.

The package contains runtime-path resolution, cache-key generation, cache
registration, and identity-aware ownership claims. It is not a user-facing API.

`withDirLock` runs short synchronous, reentrant transactions with a bounded wait
for a live holder. It shares the claim protocol in `@stim-cli/core/ownership-claim`
and the identity checks in `@stim-cli/core/process-identity`; the CLI re-exports
those modules. Core depends on `unique-pid`, so standalone Metro and Expo cache
consumers receive the same process identity implementation without installing Stim.

A complete claim left by a proven-dead owner can be recovered immediately.
Age never expires a live claim. Unknown owner or child identities refuse;
legacy directories and empty publication/removal gaps remain blocked because
there is no record proving that they are free. Verify the holder before manually
removing the named claim or legacy directory. Long operations that spawn native
children use an explicit claim and record the child's identity.

The npm scope remains `@stim-cli` until the `@stim` scope is available.
