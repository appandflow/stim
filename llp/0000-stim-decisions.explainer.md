# LLP 0000: Decisions in force

**Type:** Explainer
**Status:** Active
**Systems:** Repo
**Role:** Root
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12

## What Stim is for

Stim gives coding agents an isolated development and testing environment for
each workspace. It runs React Native and Expo apps on iOS and Android, native
iOS apps built with Xcode, native Android apps built with Gradle, Exact apps
on iOS simulators, and SwiftPM development apps on macOS. It opens web apps
in a workspace-owned Chrome session using a running web server.

Stim manages the devices and app sessions it starts, reserves a Metro port
for workspaces that use Metro, caches eligible native builds, and captures
structured logs. It reclaims disk space from build outputs, caches, and
devices under its cleanup rules. [AGENTS.md](../AGENTS.md) holds the rules for
changing this repository.

## What a decision document is

A document in `llp/` states a rule that is in force today, in the present tense,
with the reason for it. The reason is the part an agent cannot recover from the
code: the failure it prevents, or the trade the maintainer chose. Each document
covers one area, rule first, then the reason, then the maintainer's words with
their date where the maintainer decided it, then links to the issue and the
code.

A decision document is not a design. `docs/specs/` holds designs written before
a feature was built; they record what was proposed and are not kept current. A
decision document is edited whenever its rule changes, so it always describes
`main`. When a document and the code disagree, the code is the fact and the
document is the bug, unless the document marks the rule as planned.

For a rule decided but not yet on `main`, add a line like `Planned: #123`
next to the description. Use one line per issue or pull request in this
repository. When the work closes, update the rule and remove the marker.
Keep history in the issue and commits.

The [LLP planned work workflow](../.github/workflows/llp-planned.yml) checks
these numbers against GitHub weekly and on demand. A failure names the file
and line to update. For Planned work, local lint checks the marker format.
Maintainer decision: "yes to rest", 2026-11-12.
[Decision trial follow-up](https://github.com/appandflow/stim/issues/5532#issuecomment-6819290752).

## How to read them

Before changing an area, read the documents whose **Systems:** line names it.
`grep -rl "Systems:.*Cleanup" llp/` lists the cleanup decisions. Use these
labels consistently in document headers.

- Repository guidance uses `Repo`.
- Cleanup and state use `Cleanup`, `Claims`, and `Fingerprint`.
- Native and development builds use `Builds`, `Exact`, `EAS`, `Signing`, and `Metro`.
- Runtime ownership uses `Devices` and `Hosted devices`.
- Connections and services use `Desktop`, `Engine`, `Server`, `Transport`, and `Web shares`.

Code that implements a rule an agent might otherwise simplify away carries a
comment pointing at its section:

```text
// @ref LLP 0003#rung-9-runs-only-at-critical -- tool caches cost every project a re-download
```

`LLP 0003` is the file `llp/0003-*.md`; `#rung-9-runs-only-at-critical` is a
heading in it, in GitHub's slug form. Stim writes the gloss after `--`, since
source files are ASCII-only.

## How to change them

A pull request that implements a new maintainer decision adds or edits the
document in the same pull request. Quote the maintainer in the form `AGENTS.md`
defines for approved product decisions: the words `Maintainer decision:`, the
maintainer's words in double quotes exactly as written in the cited issue or
pull request comment, then the date. A rule an agent or reviewer chose is
recorded as such, with the issue or pull request that settled it, never as the
maintainer's.

A new document takes the next free number; numbers are never reused. The header
needs `Type`, `Status`, `Systems`, `Author` and `Date`, and the filename ends in
the type (`.decision.md`). `scripts/ref-check.mjs`, run by `pnpm run lint`, fails on
a missing document, a missing section, a malformed header or a reference to a
file that does not exist. It does not judge whether a document still matches the
code. It reads `@ref` followed by a space as a reference in every file git
lists except `.json` files, and only inside `<!-- -->` comments in Markdown, so
prose in code, a guide or a fixture that writes `@ref` and a space fails lint;
write it in backticks or without the space.

This repository uses the [Linked Literate Programming format](https://github.com/ccheever/llp)
and its `@ref` comments. Stim's Node checker validates the subset used in this
repository. Issues, claims, pull requests and the fresh review in `AGENTS.md`
govern the workflow.

## Documents

- [LLP 0001](./0001-disk-pressure-levels.decision.md) covers disk pressure levels and what each deletes.
- [LLP 0002](./0002-cleanup-never-deletes.decision.md) covers what cleanup never deletes, and failing closed.
- [LLP 0003](./0003-tool-caches.decision.md) covers caches of tools Stim does not own.
- [LLP 0004](./0004-discovered-checkouts.decision.md) covers checkouts Stim never ran in.
- [LLP 0005](./0005-cargo-target.decision.md) covers Cargo `target/` directories.
- [LLP 0006](./0006-build-headroom.decision.md) covers making room before a build.
- [LLP 0007](./0007-claims-and-child-cleanup.decision.md) covers claims and child cleanup.
- [LLP 0008](./0008-machine-authentication.decision.md) covers machine authentication and pairing.
- [LLP 0009](./0009-build-offload.decision.md) covers build offload and worker services.
- [LLP 0010](./0010-hosted-devices.decision.md) covers hosted runtime ownership and connections.
- [LLP 0011](./0011-web-shares.decision.md) covers web share exposure and lifetime.
- [LLP 0012](./0012-desktop-engine.decision.md) covers stim Desktop and the matching-home engine.
- [LLP 0013](./0013-owned-devices.decision.md) covers owned devices, pools, and leases.
- [LLP 0014](./0014-native-builds.decision.md) covers native build invocations, artifacts, and signing.
- [LLP 0015](./0015-compatibility-removals.decision.md) covers the compatibility mechanisms that ended in 2.0.
- [LLP 0016](./0016-stimd-managed-tunnel.decision.md) covers the managed tunnel that stimd runs.
- [LLP 0017](./0017-macos-app-supervisor.decision.md) covers why the macOS app keeps its supervisor while the other long-lived children run in stimd.
- [LLP 0018](./0018-children-that-outlive-stimd.decision.md) covers which children stimd may own, and the helpers of the dev server and the physical iPhone console.
- [LLP 0019](./0019-stimd-device-logs.decision.md) covers device log streams across a stimd crash, an update and a logs worker failure.
- [LLP 0020](./0020-test-offload.decision.md) covers the test approval and the planned `stim test` command.
- [LLP 0021](./0021-stimd-reliability.decision.md) covers stimd exit records, the crash hold and handovers with no successor.
- [LLP 0023](./0023-public-api.decision.md) covers what the `stim` package exports as public API, the frozen plugin kinds, the JSON rule and the API report gate.
- [LLP 0024](./0024-fingerprint-package-copies.decision.md) covers how installed package copies become fingerprint inputs.
