import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createFilesystemFileCache } from '../files.ts';

test('opaque files publish atomically, preserve the first writer and download into the owned destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stim-file-cache-'));
  const signal = new AbortController().signal;
  try {
    const files = createFilesystemFileCache(join(root, 'cache'));
    const sourcePath = join(root, 'source');
    await writeFile(sourcePath, 'first');
    const key = '../../outside';
    expect(await files.stat({ key, signal })).toBeNull();
    await files.store({ key, sourcePath, overwrite: false, signal });
    await writeFile(sourcePath, 'second');
    await Promise.all(Array.from({ length: 4 }, () => files.store({ key, sourcePath, overwrite: false, signal })));
    const destinationDir = join(root, 'downloads');
    const first = await files.resolve({ key, destinationDir, signal });
    if (!first) throw new Error('Expected a cached file');
    expect(dirname(first)).toBe(destinationDir);
    expect(await readFile(first, 'utf8')).toBe('first');
    await files.store({ key, sourcePath, overwrite: true, signal });
    expect(await files.stat({ key, signal })).toEqual({ size: 6 });
    const second = await files.resolve({ key, destinationDir, signal });
    if (!second) throw new Error('Expected the overwritten file');
    expect(await readFile(second, 'utf8')).toBe('second');
    expect(await readdir(join(root, 'cache'))).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
    expect(await files.resolve({ key: 'missing', destinationDir, signal })).toBeNull();
    const cancelled = AbortSignal.abort(new Error('cancelled'));
    await expect(files.store({ key, sourcePath, overwrite: true, signal: cancelled })).rejects.toThrow('cancelled');
    await expect(files.resolve({ key, destinationDir, signal: cancelled })).rejects.toThrow('cancelled');
    expect(await files.stat({ key, signal })).toEqual({ size: 6 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
