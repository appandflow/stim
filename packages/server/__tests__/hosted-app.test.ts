import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hostedAppArea,
  hostedAppBlobs,
  readHostedApp,
  type HostedAppFile,
  type HostedAppOffer,
} from '@stim-cli/core/state';
import { changeHostedApp, chunkHostedApp, offerHostedApp } from '../src/hosted-app.ts';
import { pruneHostedApps } from '../src/prune-hosted-apps.ts';

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

test('pruning preserves unknown and receiving attempts, retaining all blobs while a manifest is missing', async () => {
  const old = await manifest('old', [entry('Info.plist', 'old')]);
  const current = await manifest('current', [entry('Info.plist', 'current')]);
  const unknown = await manifest('unknown', [entry('Info.plist', 'unknown')]);
  for (const [offer, content, state] of [
    [old, 'old', 'installed'],
    [current, 'current', 'installed'],
    [unknown, 'unknown', 'unknown'],
  ] as const) {
    await chunkHostedApp(readHostedApp(session, offer.attempt), {
      sha256: sha(content),
      offset: 0,
      data: Buffer.from(content).toString('base64'),
    });
    changeHostedApp(session, offer.attempt, (record) => {
      record.state = state;
    });
  }
  const pendingFiles = [entry('Info.plist', 'pending')];
  const pendingBytes = Buffer.from(JSON.stringify(pendingFiles));
  const pending = {
    ...current,
    attempt: 'pending',
    manifest: { sha256: sha(pendingBytes), size: pendingBytes.length },
  };
  offerHostedApp(pending);
  pruneHostedApps(session, 'current');
  expect(existsSync(hostedAppArea(session, 'old'))).toBe(false);
  for (const attempt of ['current', 'unknown', 'pending'])
    expect(existsSync(hostedAppArea(session, attempt))).toBe(true);
  expect(existsSync(join(hostedAppBlobs(session), old.manifest.sha256))).toBe(true);
  await manifest('pending', pendingFiles);
  pruneHostedApps(session, 'current');
  expect(existsSync(join(hostedAppBlobs(session), old.manifest.sha256))).toBe(false);
  for (const kept of [current, unknown, pending])
    expect(existsSync(join(hostedAppBlobs(session), kept.manifest.sha256))).toBe(true);
  expect(existsSync(join(hostedAppBlobs(session), sha('old')))).toBe(false);
  for (const content of ['current', 'unknown'])
    expect(existsSync(join(hostedAppBlobs(session), sha(content)))).toBe(true);
});

test.each([
  ['malformed receipt', 'receipt is malformed'],
  ['linked attempt', 'not an owned directory'],
])('pruning keeps owned and outside data on %s', async (failure, message) => {
  const old = await manifest('old', [entry('Info.plist', 'old')]);
  changeHostedApp(session, 'old', (record) => {
    record.state = 'installed';
  });
  const current = await manifest('current', [entry('Info.plist', 'current')]);
  changeHostedApp(session, 'current', (record) => {
    record.state = 'installed';
  });
  const outside = join(home, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel'), 'outside');
  if (failure === 'linked attempt') symlinkSync(outside, hostedAppArea(session, 'linked'));
  else writeFileSync(join(hostedAppArea(session, 'old'), 'receipt.json'), '{}');
  expect(() => pruneHostedApps(session, 'current')).toThrow(message);
  for (const kept of [old, current]) expect(existsSync(join(hostedAppBlobs(session), kept.manifest.sha256))).toBe(true);
  expect(existsSync(hostedAppArea(session, 'old'))).toBe(true);
  expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('outside');
});
