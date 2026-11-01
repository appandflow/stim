import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactIn, storeArtifact } from '../artifact-store.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-artifact-store-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('a rename failure propagates when the caller has no handler', () => {
  const source = join(root, 'App.apk');
  writeFileSync(source, 'apk bytes');
  const dest = join(root, 'cache', 'entry');
  expect(() =>
    storeArtifact(dest, source, {
      runFile: execFileSync,
      writeMetadata: (staging) => rmSync(staging, { recursive: true, force: true }),
    }),
  ).toThrow(/ENOENT/);

  expect(artifactIn(dest)).toBeNull();
});
