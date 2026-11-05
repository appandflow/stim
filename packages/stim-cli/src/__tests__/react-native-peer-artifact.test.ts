import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reactNativeArtifactQuery } from '@stim-cli/core';
import type { BuildReactNativeArtifactQuery } from '@stim-cli/core/protocol';
import { BuildArtifactCache } from '../offload/build-artifact-cache.ts';
import { reactNativeArtifactReceipt, reusedReactNativeArtifact } from '../offload/react-native-artifact.ts';

const PRE = 'a'.repeat(40);
const POST = 'b'.repeat(40);
const toolchain = {
  compat: 2,
  arch: 'arm64',
  xcode: '27.1',
  simulatorSdk: '27.1',
  cocoapods: '1.16.2',
  stimBuild: 'b1',
  os: 'darwin',
};

let directory: string;
let cacheDir: string;
let out: string;

function query(fingerprint: string): BuildReactNativeArtifactQuery {
  const value = reactNativeArtifactQuery({
    project: 'example',
    fingerprint,
    toolchain,
    isExpo: false,
    platform: 'ios',
    ios: {
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-27-1',
      configuration: 'Debug',
      scheme: null,
      projectPath: 'ios',
      optimizations: { compilationCache: true, swiftCompilationCache: null, prefixMapping: true },
    },
  });
  if (!value) throw new Error('invalid query');
  return value;
}

async function retain(fingerprint: string): Promise<string> {
  const staged = join(directory, 'staged');
  mkdirSync(join(staged, 'App.app'), { recursive: true });
  writeFileSync(join(staged, 'App.app', 'Info.plist'), `built under ${fingerprint}`);
  const archive = join(directory, 'app.tgz');
  expect(spawnSync('tar', ['-czf', archive, '-C', staged, 'App.app']).status).toBe(0);
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const receipt = reactNativeArtifactReceipt(query(fingerprint), toolchain);
  if (!receipt) throw new Error('invalid receipt');
  await new BuildArtifactCache(cacheDir).storeCompleted(
    receipt.receipt.query,
    { fingerprint: receipt.identity.hash, cacheKey: receipt.identity.key },
    receipt.receipt,
    archive,
    { name: 'App.app', size: statSync(archive).size, sha256 },
    new AbortController().signal,
  );
  return sha256;
}

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'stim-rn-peer-')));
  cacheDir = join(directory, 'artifact-cache');
  out = join(directory, 'out', 'job');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

test('a rekeyed job reuses the app retained under its post-pod-install fingerprint, unpacked for a handoff', async () => {
  const sha256 = await retain(POST);
  const reused = await reusedReactNativeArtifact(
    { artifactCache: cacheDir, reuseArtifact: true, expectedFingerprint: PRE },
    query(POST),
    out,
    new AbortController().signal,
  );
  const archive = join(out, 'app.tgz');
  expect(reused).toEqual({ path: archive, name: 'App.app', size: statSync(archive).size, sha256 });
  expect(createHash('sha256').update(readFileSync(archive)).digest('hex')).toBe(sha256);
  expect(readFileSync(join(out, 'App.app', 'Info.plist'), 'utf8')).toBe(`built under ${POST}`);
});
