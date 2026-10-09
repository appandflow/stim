import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { manifestDigest } from '../../packages/stim-cli/src/offload/manifest.ts';

const sha = (content) => createHash('sha256').update(content).digest('hex');
test('native worker removes stale ignored inputs and verifies the actual provider before compilation', () => {
  const area = mkdtempSync(join(tmpdir(), 'stim-native-worker-'));
  try {
    const src = join(area, 'src');
    const blobs = join(area, 'blobs');
    mkdirSync(src);
    writeFileSync(join(src, '.gitignore'), 'ignored*\n');
    writeFileSync(join(src, 'ignored-secret'), 'stale private bytes');
    mkdirSync(join(src, 'ignored-output'));
    writeFileSync(join(src, 'ignored-output', 'stale'), 'stale compiler input');
    writeFileSync(join(src, 'Main.swift'), 'old');
    const manifest = [];
    for (const [path, content] of [
      ['.gitignore', 'ignored*\n'],
      ['Main.swift', 'new'],
    ]) {
      const digest = sha(content);
      const blob = join(blobs, digest.slice(0, 2), digest);
      mkdirSync(dirname(blob), { recursive: true });
      writeFileSync(blob, content);
      manifest.push({ path, kind: 'file', size: Buffer.byteLength(content), sha256: digest });
    }
    manifest.push({ path: 'Empty.bundle', kind: 'directory', size: 0, sha256: sha('') });
    const job = {
      job: 'native-mirror',
      area,
      blobs,
      manifest,
      platform: 'ios',
      project: '',
      packageName: null,
      isExpo: false,
      configuration: 'Debug',
      scheme: 'Missing',
      runtime: 'iOS-26-0',
      macos: null,
      android: null,
      swiftpmCache: join(area, 'swiftpm'),
      expectedFingerprint: 'input-identity',
      optimizations: null,
      native: {
        provider: 'xcode',
        sourceDigest: manifestDigest(manifest),
        cacheKey: 'artifact-identity',
        arch: 'arm64',
      },
    };
    const result = spawnSync(process.execPath, [resolve('packages/stim-cli/dist/offload-worker.mjs'), 'build'], {
      input: JSON.stringify(job),
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, STIM_HOME: join(area, 'home') },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const records = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(records.at(-1).code, 'provider-mismatch', result.stdout + result.stderr);
    assert.equal(records.at(-1).ok, false);
    assert.equal(readFileSync(join(src, 'Main.swift'), 'utf8'), 'new');
    assert.deepEqual(readdirSync(join(src, 'Empty.bundle')), []);
    assert.equal(existsSync(join(src, 'ignored-secret')), false);
    assert.equal(existsSync(join(src, 'ignored-output')), false);
    assert.equal(existsSync(join(area, 'out')), false);
    assert.equal(
      records.some((record) => record.phase === 'build'),
      false,
    );
  } finally {
    rmSync(area, { recursive: true, force: true });
  }
});
