# @stim-cli/core

Shared internal contracts for Stim and its cache packages.

The package contains runtime-path resolution, cache-key generation, cache
registration, filesystem artifact storage, and identity-aware ownership claims. It is not a user-facing API.

`withDirLock` runs short synchronous, reentrant transactions with a bounded wait
for a live holder. It shares the claim protocol in `@stim-cli/core/ownership-claim`
and the identity checks in `@stim-cli/core/process-identity`; the CLI re-exports
those modules. Core depends on `unique-pid`, so standalone Metro and Expo cache
consumers receive the same process identity implementation without installing Stim.

The exclusive claim at `<lock>.claims` is the only short-lock state. The
adapter does not create, inspect or remove `<lock>` itself.

A complete claim left by a proven-dead owner can be recovered immediately.
Age never expires a live claim. Unknown owner or child identities refuse;
verify the holder before manually removing the named claim. Long operations that spawn native
children use an explicit claim and record the child's identity.

`@stim-cli/core/state` holds the read side of Stim's state: the `$STIM_HOME`
path layout, the config and workspace state types and readers, the settings
registry and its JSON Schema, the created-device and EAS session ledger readers,
NDJSON log records and queries, and the status and settings payload types. The
CLI owns every write to that state. The cache packages do not import it.
Setup journals are an exception: stim-server writes and prunes
`$STIM_HOME/server/setup/<sha256(ticket) hex>.json`; core owns their paths,
strict parser and reader.

`@stim-cli/core/oversight` holds the pure notification and needs-attention rules
shared by stim-server and the phone. It imports no Node APIs; mobile consumers
import this subpath without loading the Node-only root or state entry points.
Build core before typechecking, testing or bundling the phone app.
Its `wakeAt` includes physical-device lease expiry and unattended EAS-session age;
callers retain their clock and quiet-hours reevaluation.

The npm scope remains `@stim-cli` until the `@stim` scope is available.

`@stim-cli/core/protocol` defines the server's wire contracts. The
`phone-protocol` entry derives the phone's receiving types, including optional
fields from older servers. `receive-protocol` contains precompiled validators
for method results, known events and errors, with no Node or schema compiler
dependency in the phone runtime. Unknown compatible fields remain accepted.
Display enums accept open strings, and unknown values show neutral information or are skipped when unsupported.

After changing these contracts, run `pnpm run rpc:generate` at the repository
root; `pnpm run rpc:check` verifies the committed validators in CI.
