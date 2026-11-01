import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostedAppBlobs, readHostedApp, type HostedAppFile, type HostedAppOffer } from '@stim-cli/core/state';
import { chunkHostedApp, offerHostedApp } from '../src/hosted-app.ts';

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
