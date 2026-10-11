# @stim-cli/cache

The cache provider contract Stim uses for Metro transforms and native build
artifacts, plus the tier coordination, timeout, and warning policy that sit in
front of it.

The local filesystem is always the first tier. A project can add one optional
second tier by pointing `cache.provider` at a module that implements this
contract. `@stim-cli/cache/s3` provides an S3-compatible second tier, including
Cloudflare R2.

If Stim is not installed globally, replace `stim` with `npx stim`.

## Selecting a provider

```json
{
  "cache": {
    "provider": "./tools/cache-provider.cjs",
    "options": { "bucket": "mobile-cache" }
  }
}
```

The reference is a package name or a path relative to the settings file that
declares it. Commit `.stim.json` beside the app's `package.json`; monorepo apps do
not inherit an ancestor's provider. Machine settings override committed settings. `cache.options` merges by key
from the layer that selects the provider, higher-precedence layers that name no
provider, and lower-precedence layers that name the same provider resolved from
the same directory; options written for another provider are ignored. Keep secrets out of
committed settings; read them from the environment or from machine settings.

## S3-compatible storage

Install `@stim-cli/cache` in the project, then select its S3 provider in
`.stim.json`:

```json
{
  "cache": {
    "provider": "@stim-cli/cache/s3",
    "options": {
      "bucket": "stim-cache",
      "endpoint": "https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com",
      "region": "auto",
      "prefix": "team/cache-v1"
    }
  }
}
```

For AWS S3, omit `endpoint` and use the bucket's region. Other S3-compatible
services can set `forcePathStyle: true` when required. Credentials use the AWS
SDK's standard credential chain. For a named profile in `~/.aws/credentials`,
set `cache.options.profile` to `stim-r2`, or run commands with
`AWS_PROFILE=stim-r2`, for example `AWS_PROFILE=stim-r2 stim ios`. An explicit
cache profile overrides the ambient AWS profile. Credentials never belong in `.stim.json`.

Create a private R2 bucket and an R2 API token with Object Read & Write access
scoped to that bucket. Copy the S3 endpoint shown by Cloudflare; jurisdiction
specific buckets use their own endpoint. See the
[R2 S3 setup guide](https://developers.cloudflare.com/r2/get-started/s3/).

The provider shares completed native `.app`/`.apk` artifacts and Metro values
through one file transport. Stim checks its local tier first and promotes build
hits locally. Build archives preserve file modes and contained framework links;
downloads verify SHA-256 before becoming reusable. Conditional writes preserve
existing build entries unless overwrite was requested. Use matching native
toolchains for the initial test; the provider does not add toolchain information
to Stim's existing build key.

The file transport is also exported as `createS3FileCache()` from
`@stim-cli/cache/s3`, with the `FileCacheCapability` interface exported from
`@stim-cli/cache`. A cache adapter supplies a compatible key and a completed
file, then owns the downloaded file inside its destination directory. This
allows dependency snapshots and other cache adapters to reuse the transport
later. Other Stim home directories are not automatically synchronized.

Objects use `<prefix>/builds/<platform>/<key>` and
`<prefix>/metro/<cacheName>/<hex-key>`. A prefix defaults to `stim/v1`. Keep
incompatible snapshot formats in separate key namespaces. Retention belongs to
the bucket lifecycle configuration; local GC never removes shared objects.
Uploads use a single S3 PUT, so entries larger than S3's 5 GiB limit are not
supported by this initial provider.

## Writing a provider

```js
export const apiVersion = 1;

export async function createCacheProvider({ projectRoot, options }) {
  return {
    metro: {
      async get({ key, cacheName, signal }) {
        return null;
      },
      async set({ key, value, cacheName, signal }) {},
    },
    builds: {
      async resolve({ platform, key, destinationDir, signal }) {
        return null;
      },
      async store({ platform, key, sourcePath, overwrite, signal }) {},
    },
  };
}
```

A provider implements one or more capabilities. It owns transport,
serialization, archive format, authentication, and remote retention. Stim owns
fingerprints, cache keys, and local artifact paths.

The optional `files` capability stores opaque complete files with
`store({ key, sourcePath, overwrite, signal })` and downloads them with
`resolve({ key, destinationDir, signal })`. A hit returns a path inside
`destinationDir`; a miss returns `null` and leaves it empty. The CLI consumes
the `metro` and `builds` adapters; a files-only provider is available to cache
adapters that use this interface directly.

`metro.get` returns the stored value or `null`.

`builds.resolve` returns an existing path to the artifact, or `null` for a
miss. `destinationDir` is a scratch directory Stim creates and owns: a provider
that fetches the artifact must materialize it there and return a path inside
it, and must leave the directory empty on a miss. The built-in filesystem tier
already holds the artifact, so it returns its own cache path instead.

`builds.store` receives the `.app` directory or `.apk` file that Stim just
built. `overwrite: false` must keep an entry that already exists for the key,
and `overwrite: true` must replace it.

Every call receives an `AbortSignal`. A provider must honor it: Stim abandons
the call at the deadline and keeps building or bundling with the local tier.

`stim gc` never deletes provider data, and the contract has no delete
operation, so shared team or CI data is never removed by a local command.

## Failure rules

Provider failures are cache misses. A timeout, module error, authentication
error, or network error produces one warning per failure class per command or
supervisor run and never fails a bundle, an install, a launch, or a successful
build.

## Contract tests

Run the shipped checks against your own module:

```js
import { runCacheProviderContract } from '@stim-cli/cache';

const results = await runCacheProviderContract({
  provider: await createCacheProvider({ projectRoot, options }),
  projectRoot,
  workDir,
});

for (const result of results) {
  if (!result.passed) throw new Error(`${result.name}: ${result.error}`);
}
```

Pass `providerModule` instead of `provider` to load the module the way Stim
does, which also checks `apiVersion` and the factory:

```js
const results = await runCacheProviderContract({
  providerModule: './tools/cache-provider.cjs',
  projectRoot,
  workDir,
});
```

`cacheProviderContractChecks()` returns the same checks as individual cases for
a test runner that reports each one separately. Both helpers check advertised
Metro and build capabilities, bound every check with a deadline, and
verify that a call settles once its `AbortSignal` aborts.

## Budgets

Every provider call is bounded. The defaults are 2s for a Metro read, 10s for a
Metro write, 30s for a build lookup, 60s for a build upload, and 10s to load the
module. Override any of them per run with an environment variable:

```bash
STIM_CACHE_METRO_READ_TIMEOUT_MS=5000 stim start
STIM_CACHE_BUILD_RESOLVE_TIMEOUT_MS=60000 stim ios
```

The variables are `STIM_CACHE_METRO_READ_TIMEOUT_MS`,
`STIM_CACHE_METRO_WRITE_TIMEOUT_MS`, `STIM_CACHE_BUILD_RESOLVE_TIMEOUT_MS`,
`STIM_CACHE_BUILD_UPLOAD_TIMEOUT_MS`, and `STIM_CACHE_LOAD_TIMEOUT_MS`. Each
takes whole milliseconds; any other value keeps the default.

The tiered Metro store also exposes `flush()`, which resolves once queued
provider writes have drained. Metro never calls it; every in-flight write holds
a referenced deadline, so a Metro process drains on its own within the write
budget. It exists for tests and embedders that own the process.

Metro reads are also capped: at most six can be in flight, and the tier turns
itself off for the rest of the run after five consecutive failures, so a broken
provider costs one round of warnings rather than a timeout per transform.

The npm scope remains `@stim-cli` until the `@stim` scope is available.
