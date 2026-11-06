# @stim-cli/metro

Optional Metro integration for Stim. It exports a transform cache shared across
worktrees and an NDJSON reporter for structured Metro and client logs.

If Stim is not installed globally, replace `stim` with `npx stim`.

```bash
npm install --save-dev @stim-cli/metro
```

## Shared transforms

Set `cacheStores` on the final merged Metro config:

```js
const { sharedCacheStores } = require('@stim-cli/metro');
const { name } = require('./package.json');

config.cacheStores = sharedCacheStores(name);
```

For bare React Native under Stim, this explicitly selects one shared transform
store. Stim's automatic setup preserves Metro's default `os.tmpdir()/metro-cache`
store; this assignment replaces it and any custom stores in `cacheStores`.
Using the package name lets Stim recognize the shared store without adding another.

Set `STIM_METRO_CACHE` to an absolute path to override the shared cache location.
A relative value is ignored with a warning.

## Log reporter

```js
const { ndjsonReporter } = require('@stim-cli/metro');

config.reporter = ndjsonReporter({ dir: '/absolute/log/directory' });
```

It writes `metro.ndjson` and `client.ndjson`. When a file reaches about 8 MiB it is
renamed to `<name>.1`, replacing the previous one, and a new file starts.

The reporter must be attached to the config passed directly to
`Metro.runServer`. React Native and Expo CLIs can replace a reporter declared in
`metro.config.js`.

Stim supplies this integration automatically for Stim-managed servers. Direct
configuration is optional: use it for the explicit store choice above or for
Metro processes that run outside Stim.

See the [cache package documentation](https://stim.appandflow.com/docs/cache-packages)
for current usage and cleanup guidance.
