# LLP 0000: Decisions in force

**Type:** Explainer
**Status:** Active
**Systems:** Repo
**Role:** Root
**Author:** Janic Duplessis / Claude
**Date:** 2026-11-12

## What Stim is for

Stim gives each React Native or Expo workspace an isolated Metro port and an
owned simulator or emulator, caches native builds, captures structured logs, and
keeps the machine it runs on usable: it reclaims the disk its builds and devices
consume. `AGENTS.md` holds the rules for changing this repository.

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

A rule decided but not yet on `main` sits under a heading that says planned and
names its issue. History stays in issues and commits: when a decision changes,
edit the document; do not append to it.

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
the type (`.decision.md`). `scripts/ref-check`, run by `pnpm run lint`, fails on
a missing document, a missing section, a malformed header or a reference to a
file that does not exist. It does not judge whether a document still matches the
code. It reads `@ref` followed by a space as a reference in every file git
lists except `.json` files, and only inside `<!-- -->` comments in Markdown, so
prose in code, a guide or a fixture that writes `@ref` and a space fails lint;
write it in backticks or without the space.

This repository uses the format of Linked Literate Programming
(https://github.com/ccheever/llp), its `@ref` comments and its checker, not its
process: there is no `llp/current/` or `llp/foundation/`, no review loop and no
skills. Issues, claims, pull requests and the fresh review in `AGENTS.md` stay
the workflow.

## Documents

- LLP 0001: disk pressure levels and what each deletes.
- LLP 0002: what cleanup never deletes, and failing closed.
- LLP 0003: caches of tools Stim does not own.
- LLP 0004: checkouts Stim never ran in.
- LLP 0005: Cargo `target/` directories.
- LLP 0006: making room before a build.
- LLP 0007: claims and child cleanup.
- [LLP 0008](./0008-machine-authentication.decision.md) covers machine authentication and pairing.
- [LLP 0009](./0009-build-offload.decision.md) covers build offload and worker services.
- [LLP 0010](./0010-hosted-devices.decision.md) covers hosted runtime ownership and connections.
- [LLP 0011](./0011-web-shares.decision.md) covers web share exposure and lifetime.
- [LLP 0012](./0012-desktop-engine.decision.md) covers stim Desktop and the matching-home engine.
- [LLP 0013](./0013-owned-devices.decision.md) covers owned devices, pools, and leases.
- [LLP 0014](./0014-native-builds.decision.md) covers native build invocations, artifacts, and signing.
- [LLP 0015](./0015-compatibility-removals.decision.md) covers the compatibility mechanisms that ended in 2.0.
- [LLP 0021](./0021-stimd-reliability.decision.md) covers stimd exit records, the crash hold and handovers with no successor.
