import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createFilesystemFileCache } from '@stim-cli/cache';
import { isJsonObject } from '@stim-cli/core/state';
import type { BuildArtifactIdentity, BuildArtifactResult, CachedBuildArtifact } from './protocol.ts';

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
        !record.name.endsWith('.app') ||
        typeof record.size !== 'number' ||
        !Number.isSafeInteger(record.size) ||
        record.size <= 0 ||
        typeof record.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.sha256)
      )
        return null;
      const info = await this.files.stat({ key: record.sha256, signal });
      if (info?.size !== record.size) return null;
      return { ...identity, name: record.name, size: record.size, sha256: record.sha256 };
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
  ): Promise<void> {
    if (!validArtifactIdentity(identity) || !(await verified(archive, artifact, signal))) return;
    await this.files.store({ key: artifact.sha256, sourcePath: archive, overwrite: true, signal });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `${randomUUID()}.partial`);
    try {
      await writeFile(temporary, JSON.stringify({ ...identity, ...artifact, parameters }), { mode: 0o600, signal });
      signal.throwIfAborted();
      await rename(temporary, this.record(identity));
    } finally {
      await rm(temporary, { force: true });
    }
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
