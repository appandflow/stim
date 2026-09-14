# @stim-cli/core

Shared internal contracts for Stim and its cache packages.

The package contains runtime-path resolution, cache-key generation, cache
registration, filesystem artifact storage, and identity-aware ownership claims. It is not a user-facing API.

`withDirLock` runs short synchronous, reentrant transactions with a bounded wait
for a live holder. It shares the claim protocol in `@stim-cli/core/ownership-claim`
and the identity checks in `@stim-cli/core/process-identity`; the CLI re-exports
those modules. Core depends on `unique-pid`, so standalone Metro and Expo cache
consumers receive the same process identity implementation without installing Stim.

The shared claim lives beside the visible lock directory at `<lock>.claims`.
While holding its exclusive claim, the short-lock adapter takes the visible
directory and adds a `.stim-claim-<claimId>` compatibility marker. Older callers
still see an occupied directory. Publication staging stays in the claim store,
so a losing publisher cannot prevent the visible directory's release. Only the
holder of the exclusive claim can recover a recognized compatibility marker;
release removes its own marker before removing the empty visible directory.
This preserves ordinary legacy mkdir contention; an older caller that deletes
occupied locks based on their age can still violate mutual exclusion.

A complete claim left by a proven-dead owner can be recovered immediately.
Age never expires a live claim. Unknown owner or child identities refuse;
legacy directories and visible directories left empty before marker publication
or after marker removal remain blocked because there is no record proving that
they are free. Verify the holder before manually
removing the named claim or legacy directory. Long operations that spawn native
children use an explicit claim and record the child's identity.

The npm scope remains `@stim-cli` until the `@stim` scope is available.
