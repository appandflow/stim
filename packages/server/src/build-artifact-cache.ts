import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { reactNativeArtifactIdentity } from '@stim-cli/core';
import { createFilesystemFileCache } from '@stim-cli/cache';
import { isJsonObject } from '@stim-cli/core/state';
import type {
  BuildArtifactIdentity,
  BuildArtifactResult,
  BuildGradleArtifactQuery,
  BuildReactNativeArtifactQuery,
  CachedBuildArtifact,
} from './protocol.ts';

const androidPackage = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(value);

function gradleQueryKey(query: BuildGradleArtifactQuery): string {
  const { android, inputs } = query;
  return createHash('sha256')
    .update(
      JSON.stringify([
        query.project,
        query.sourceDigest,
        inputs.ignored,
        inputs.outputs,
        android.variant,
        android.abi === 'all' ? null : android.abi,
        android.compilerCache,
        android.gradleBuildCache,
        android.pch,
        android.gradleRoot ?? null,
        android.module ?? null,
      ]),
    )
    .digest('hex');
}

export function validArtifactIdentity(value: unknown): value is BuildArtifactIdentity {
  return (
    isJsonObject(value) &&
    typeof value.fingerprint === 'string' &&
    value.fingerprint.length > 0 &&
    value.fingerprint.length <= 256 &&
    typeof value.cacheKey === 'string' &&
    value.cacheKey.length > 0 &&
    value.cacheKey.length <= 1024
  );
}

async function verified(path: string, artifact: BuildArtifactResult, signal: AbortSignal): Promise<boolean> {
  const digest = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    size += chunk.length;
    digest.update(chunk);
  }
  return size === artifact.size && digest.digest('hex') === artifact.sha256;
}

/** Completed immutable archives within one authenticated client's repository area. */
export class BuildArtifactCache {
  private readonly files;

  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
    this.files = createFilesystemFileCache(join(directory, 'files'));
  }

  private record(identity: BuildArtifactIdentity): string {
    const key = createHash('sha256')
      .update(JSON.stringify([identity.fingerprint, identity.cacheKey]))
      .digest('hex');
    return join(this.directory, `${key}.json`);
  }

  async lookup(identity: BuildArtifactIdentity, signal: AbortSignal): Promise<CachedBuildArtifact | null> {
    signal.throwIfAborted();
    try {
      const record: unknown = JSON.parse(await readFile(this.record(identity), { encoding: 'utf8', signal }));
      if (
        !isJsonObject(record) ||
        record.fingerprint !== identity.fingerprint ||
        record.cacheKey !== identity.cacheKey ||
        typeof record.name !== 'string' ||
        basename(record.name) !== record.name ||
        !(record.name.endsWith('.app') || (record.name.endsWith('.apk') && androidPackage(record.androidPackage))) ||
        typeof record.size !== 'number' ||
        !Number.isSafeInteger(record.size) ||
        record.size <= 0 ||
        typeof record.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.sha256)
      )
        return null;
      const info = await this.files.stat({ key: record.sha256, signal });
      if (info?.size !== record.size) return null;
      return {
        ...identity,
        name: record.name,
        size: record.size,
        sha256: record.sha256,
        ...(record.name.endsWith('.apk') && androidPackage(record.androidPackage)
          ? { androidPackage: record.androidPackage }
          : {}),
      };
    } catch {
      signal.throwIfAborted();
      return null;
    }
  }

  async store(
    identity: BuildArtifactIdentity,
    parameters: Record<string, unknown>,
    archive: string,
    artifact: BuildArtifactResult,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!validArtifactIdentity(identity) || !(await verified(archive, artifact, signal))) return false;
    await this.files.store({ key: artifact.sha256, sourcePath: archive, overwrite: true, signal });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `${randomUUID()}.partial`);
    try {
      await writeFile(temporary, JSON.stringify({ ...identity, ...artifact, parameters }), { mode: 0o600, signal });
      signal.throwIfAborted();
      await rename(temporary, this.record(identity));
      return true;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async storeCompleted(
    query: BuildGradleArtifactQuery | BuildReactNativeArtifactQuery,
    identity: BuildArtifactIdentity,
    receipt: unknown,
    archive: string,
    artifact: BuildArtifactResult & { androidPackage?: string },
    signal: AbortSignal,
  ): Promise<void> {
    if ('sourceDigest' in query || query.platform === 'android') {
      if (!artifact.name.endsWith('.apk') || !androidPackage(artifact.androidPackage)) return;
    } else if (!artifact.name.endsWith('.app')) return;
    if (!(await this.store(identity, { ...query }, archive, artifact, signal))) return;
    const key =
      'sourceDigest' in query
        ? gradleQueryKey(query)
        : createHash('sha256').update(JSON.stringify(query)).digest('hex');
    const temporary = join(this.directory, `${randomUUID()}.partial`);
    try {
      await writeFile(temporary, JSON.stringify({ query: key, receipt }), { mode: 0o600, signal });
      signal.throwIfAborted();
      await rename(
        temporary,
        join(this.directory, `${key}.${'sourceDigest' in query ? 'gradle' : 'react-native'}.json`),
      );
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async completedRecord(
    query: BuildGradleArtifactQuery | BuildReactNativeArtifactQuery,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    signal.throwIfAborted();
    try {
      const key =
        'sourceDigest' in query
          ? gradleQueryKey(query)
          : createHash('sha256').update(JSON.stringify(query)).digest('hex');
      const record: unknown = JSON.parse(
        await readFile(join(this.directory, `${key}.${'sourceDigest' in query ? 'gradle' : 'react-native'}.json`), {
          encoding: 'utf8',
          signal,
        }),
      );
      return isJsonObject(record) && record.query === key && isJsonObject(record.receipt) ? record : null;
    } catch {
      signal.throwIfAborted();
      return null;
    }
  }

  async receipt(
    query: BuildGradleArtifactQuery | BuildReactNativeArtifactQuery,
    signal: AbortSignal,
  ): Promise<unknown | null> {
    return (await this.completedRecord(query, signal))?.receipt ?? null;
  }

  async lookupReactNative(
    query: BuildReactNativeArtifactQuery,
    signal: AbortSignal,
  ): Promise<CachedBuildArtifact | null> {
    const record = await this.completedRecord(query, signal);
    if (
      !record ||
      !isJsonObject(record.receipt) ||
      !isJsonObject(record.receipt.toolchain) ||
      !isDeepStrictEqual(record.receipt.query, query)
    )
      return null;
    return this.lookup(reactNativeArtifactIdentity({ query, toolchain: record.receipt.toolchain }), signal);
  }

  async fetch(
    identity: BuildArtifactIdentity,
    destinationDir: string,
    signal: AbortSignal,
  ): Promise<{ path: string; artifact: CachedBuildArtifact } | null> {
    const artifact = await this.lookup(identity, signal);
    if (!artifact) return null;
    const path = await this.files.resolve({ key: artifact.sha256, destinationDir, signal });
    if (!path) return null;
    let complete = false;
    try {
      complete = await verified(path, artifact, signal);
      return complete ? { path, artifact } : null;
    } finally {
      if (!complete) await rm(path, { force: true });
    }
  }
}
