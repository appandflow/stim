# LLP 0022: Installed package copies in the fingerprint

**Type:** Decision
**Status:** Active
**Systems:** Fingerprint, Builds
**Author:** Claude
**Date:** 2026-11-12
**Related:** LLP 0014

An agent chose these rules while fixing
[#5508](https://github.com/appandflow/stim/issues/5508); the maintainer has not
stated them.

## Packages the config evaluation loads are inputs

A package whose code runs while Stim evaluates the app config, Expo
autolinking or the React Native CLI config is an input of the native build
key. A copy the lockfile vouches for (a registry tarball with its integrity)
is one `package:<name>` row of identities. A copy the lockfile cannot vouch
for is hashed by content: every file the evaluation loaded from it is a file
row named `npm:<name>/<subpath>`. That form does not depend on the checkout
path or on the package manager's layout, so hoisted, nested and pnpm installs
of the same copy key the same.

Stim cannot tell which loaded code shapes the config that prebuild and
autolinking produce, so it keys all of it; a lockfile it cannot read costs
hashing, never a false hit. npm sometimes writes lockfile entries without
`resolved` and `integrity`. Expensify App's `package-lock.json` has 1,082 such
entries, among them two `supports-color` copies the React Native CLI loads, so
those copies are hashed by content.

## Each installed version of a package is its own input

When the loaded rows of one package come from copies at two or more versions,
every row of that package is named `npm:<name>@<version>/<subpath>`. A package
loaded from copies at a single version keeps the bare name. The version comes
from the copy's own `package.json`.

Two versions are two different inputs: a change to either copy must change the
key, and a miss report must say which copy changed. Merging them under one name
made the key throw and the whole project build uncached
([#5508](https://github.com/appandflow/stim/issues/5508)). A name and version,
unlike an install path, is the same under npm, pnpm and Yarn layouts. Keeping
the bare name when only one version is loaded leaves those projects' rows
unchanged.

## Copies at one version share a row

Two copies of one package at the same version whose loaded file differs, such
as a nested copy patched and a hoisted one not, share the row of that name. Its
hash is the hash of their sorted distinct file hashes, so a change to either
copy changes the key. Two copies with identical bytes collapse into one row as
before.

The only thing that tells such copies apart is where they are installed, and a
name built from the install path would differ between package managers and
between hoisting outcomes of the same lockfile. Any other two rows of one name
that disagree remain an error in the stage that produced them.

Only rows of the files the evaluation loaded carry the copy's version. An
`npm:` row from a walked tree or an environment path carries none, so if one
ever meets a loaded row of another copy under one name, the key is still
refused rather than guessed.

## Code

- [Row naming and merging](../packages/stim-cli/src/fingerprint/key.ts) and [the version of each loaded content row](../packages/stim-cli/src/fingerprint/evaluate.ts).
