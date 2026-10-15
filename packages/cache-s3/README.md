# @stim-cli/cache-s3

This opt-in provider owns the AWS SDK and archive dependencies. Installing
Stim or `@stim-cli/cache` alone does not install it.

If Stim is not installed globally, replace `stim` with `npx stim`.

Install the provider in the project:

```bash
npm install @stim-cli/cache-s3
```

Then select it in `.stim.json`:

```json
{
  "cache": {
    "provider": "@stim-cli/cache-s3",
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
`@stim-cli/cache-s3`, with the `FileCacheCapability` interface exported from
`@stim-cli/cache`. A cache adapter supplies a compatible key and a completed
file, then owns the downloaded file inside its destination directory. This
also lets native Gradle artifact caching share the completed APK and verification
receipt through this transport when `android.artifactInputs` is declared. Private
input files and environment values stay local. Other Stim home directories are
not automatically synchronized.

Objects use `<prefix>/builds/<platform>/<key>` and
`<prefix>/metro/<cacheName>/<hex-key>`. Native Gradle APKs use
`<prefix>/native-android/v1/<key>`. A prefix defaults to `stim/v1`. Keep
incompatible snapshot formats in separate key namespaces. Retention belongs to
the bucket lifecycle configuration; local GC never removes shared objects.
Uploads use a single S3 PUT, so entries larger than S3's 5 GiB limit are not
supported by this initial provider.
