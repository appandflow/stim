---
title: 'Cache packages'
sidebar_position: 5
description: 'S3-compatible artifact storage and retired cache packages'
---

:::note[Command examples]

Commands use `stim`. If it is not installed globally, replace `stim` with
`npx stim`.

:::

Stim supplies its own cache arguments when it runs Metro and native builds.
Install `stim` and use `stim start`, `stim ios`, or `stim android`.

## S3-compatible artifact storage

Install `@stim-cli/cache-s3` for remote native artifact storage. See
[Build caches](./build-caches.md) for provider configuration.

## Retired Expo build-cache provider

`@stim-cli/expo-build-cache` is no longer shipped or published. Published versions
stay installable, but Stim's engine no longer reads a cache written by them.
Remove it from the project's dependencies and Expo `buildCacheProvider` config.
Use `stim ios` and `stim android` for native builds with Stim's own cache.
