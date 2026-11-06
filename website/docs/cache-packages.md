---
title: 'Cache packages'
sidebar_position: 5
description: 'Optional npm packages for shared caches and explicit Metro configuration'
---

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

Stim supplies its own cache arguments when it runs Metro and native builds. A
project does not need these packages for `stim start`, `stim ios`, or
`stim android`.

Use these packages for tools outside Stim or for explicit cache configuration.

## `@stim-cli/metro`

This package exports a shared Metro `FileStore` and the NDJSON reporter used by
Stim. Add it to a custom Metro process when that process must share transforms
with Stim-managed workspaces.

```bash
npm install --save-dev @stim-cli/metro
```

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

`@stim-cli/metro` works without the `stim` npm package. It registers its cache
directories in Stim's cache manifest when available, so `stim gc` can report and
trim them.

## Retired Expo build-cache provider

`@stim-cli/expo-build-cache` is no longer shipped or published. Published versions
stay installable, but Stim's engine no longer reads a cache written by them.
Remove it from the project's dependencies and Expo `buildCacheProvider` config.
Use `stim ios` and `stim android` for native builds with Stim's own cache.
