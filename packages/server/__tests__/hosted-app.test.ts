import { createHash } from 'node:crypto';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostedAppBlobs, readHostedApp, type HostedAppFile, type HostedAppOffer } from '@stim-cli/core/state';
import { chunkHostedApp, handOverHostedApp, offerHostedApp } from '../src/hosted-app.ts';

let home: string;
const session = '12345678-1234-1234-1234-123456789abc';
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-host-blobs-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

async function manifest(attempt: string, files: HostedAppFile[]): Promise<HostedAppOffer> {
  const bytes = Buffer.from(JSON.stringify(files));
  const offer: HostedAppOffer = {
    session,
    attempt,
    bundleId: 'dev.fixture',
    mode: 'release',
    manifest: { sha256: sha(bytes), size: bytes.length },
  };
  const missing = offerHostedApp(offer).missing;
  if (missing.length)
    await chunkHostedApp(readHostedApp(session, attempt), {
      sha256: sha(bytes),
      offset: 0,
      data: bytes.toString('base64'),
    });
  return offer;
}
const entry = (path: string, content: string): HostedAppFile => ({
  path,
  kind: 'file',
  size: Buffer.byteLength(content),
  sha256: sha(content),
});

test.each(['ios', 'macos', 'android'])(
  'a second %s attempt requests only changed bytes from its session store',
  async (platform) => {
    const unchanged = entry(platform === 'macos' ? 'Contents/Info.plist' : 'Info.plist', 'metadata');
    const old = {
      ...entry(
        platform === 'macos' ? 'Contents/MacOS/Fixture' : platform === 'android' ? 'App.apk' : 'Fixture',
        'old binary',
      ),
      kind: platform === 'macos' ? ('exec' as const) : ('file' as const),
    };
    const firstFiles = platform === 'android' ? [old] : [unchanged, old];
    const first = await manifest('first', firstFiles);
    for (const file of firstFiles)
      await chunkHostedApp(readHostedApp(session, 'first'), {
        sha256: file.sha256,
        offset: 0,
        data: Buffer.from(file === old ? 'old binary' : 'metadata').toString('base64'),
      });
    expect(offerHostedApp(first).missing).toEqual([]);
    const next = { ...old, sha256: sha('new binary') };
    const second = await manifest('second', platform === 'android' ? [next] : [unchanged, next]);
    expect(offerHostedApp(second).missing).toEqual([{ sha256: next.sha256, size: next.size, offset: 0 }]);
    const same = await manifest('same', firstFiles);
    expect(offerHostedApp(same).missing).toEqual([]);
    const foreign = { ...same, session: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
    expect(offerHostedApp(foreign).missing).toEqual([{ ...same.manifest, offset: 0 }]);
  },
);

test('corrupt complete blobs and unfinished chunks cannot be reused as verified content', async () => {
  const file = entry('Info.plist', 'verified bytes');
  const first = await manifest('first', [file]);
  const blob = join(hostedAppBlobs(session), file.sha256);
  writeFileSync(blob, 'corrupt! bytes');
  expect(offerHostedApp(first).missing).toEqual([{ sha256: file.sha256, size: file.size, offset: 0 }]);
  const record = readHostedApp(session, 'first');
  await chunkHostedApp(record, { sha256: file.sha256, offset: 0, data: Buffer.from('verified').toString('base64') });
  const second = await manifest('second', [file]);
  expect(offerHostedApp(second).missing).toEqual([{ sha256: file.sha256, size: file.size, offset: 8 }]);
  expect(() => readFileSync(blob)).toThrow(/ENOENT/);
  await expect(
    chunkHostedApp(record, { sha256: file.sha256, offset: 8, data: Buffer.from(' wrong').toString('base64') }),
  ).rejects.toThrow('digest mismatch');
  expect(offerHostedApp(second).missing[0]?.offset).toBe(0);
  writeFileSync(`${blob}.part`, 'corrupt! bytes');
  expect(offerHostedApp(second).missing[0]?.offset).toBe(0);
  writeFileSync(join(hostedAppBlobs(session), first.manifest.sha256), 'broken manifest');
  expect(offerHostedApp(first).missing).toEqual([{ ...first.manifest, offset: 0 }]);
});

test('handoff fills only simulator bundle bytes matching the manifest, leaving edited files for upload', async () => {
  const files = [entry('Info.plist', 'plist'), entry('Fixture', 'client binary')];
  const offer = await manifest('ios', files);
  const bundle = join(home, 'Build.app');
  mkdirSync(bundle);
  writeFileSync(join(bundle, 'Info.plist'), 'plist');
  writeFileSync(join(bundle, 'Fixture'), 'worker binary');
  expect(await handOverHostedApp(readHostedApp(session, 'ios'), bundle)).toEqual({ files: 1, bytes: 5 });
  expect(offerHostedApp(offer).missing).toEqual([{ sha256: files[1]!.sha256, size: files[1]!.size, offset: 0 }]);
});

test('chunk refuses a symlinked partial without modifying its target', async () => {
  const file = entry('Info.plist', 'verified bytes');
  await manifest('first', [file]);
  const target = join(home, 'outside');
  writeFileSync(target, 'verified');
  symlinkSync(target, join(hostedAppBlobs(session), `${file.sha256}.part`));
  await expect(
    chunkHostedApp(readHostedApp(session, 'first'), {
      sha256: file.sha256,
      offset: 8,
      data: Buffer.from(' bytes').toString('base64'),
    }),
  ).rejects.toThrow('not a regular file');
  expect(readFileSync(target, 'utf8')).toBe('verified');
});

test('the first offer reuses uploaded verification, but same-size edits invalidate it', async () => {
  const reads = vi.spyOn(fs, 'readSync');
  syncBuiltinESMExports();
  try {
    const file = entry('Info.plist', 'verified bytes');
    const offer = await manifest('first', [file]);
    await chunkHostedApp(readHostedApp(session, 'first'), {
      sha256: file.sha256,
      offset: 0,
      data: Buffer.from('verified bytes').toString('base64'),
    });
    expect(reads).toHaveBeenCalled();
    reads.mockClear();
    expect(offerHostedApp(offer).missing).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
    writeFileSync(join(hostedAppBlobs(session), file.sha256), 'corrupt! bytes');
    expect(offerHostedApp(offer).missing).toEqual([{ sha256: file.sha256, size: file.size, offset: 0 }]);
    expect(reads).toHaveBeenCalled();
  } finally {
    reads.mockRestore();
    syncBuiltinESMExports();
  }
});
