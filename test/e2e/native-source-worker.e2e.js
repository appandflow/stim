import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { manifestDigest } from '../../packages/stim-cli/src/offload/manifest.ts';
import { nativeTransferManifest } from '../../packages/stim-cli/src/offload/native-source.ts';
import { nativeXcodeIosProject } from '../../packages/stim-cli/src/integrations/native-xcode-ios.ts';
import { writeNativeXcodeProject } from '../../packages/stim-cli/src/__tests__/_native-xcode-project.ts';

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

async function runNativeIdentityJob(area, prepareClient, workerEnv) {
  const saved = { PATH: process.env.PATH, STIM_HOME: process.env.STIM_HOME };
  try {
    const tools = join(area, 'tools');
    mkdirSync(tools);
    for (const name of ['xcodebuild', 'xcrun', 'xcode-select'])
      writeFileSync(join(tools, name), '#!/bin/sh\necho "fake $(basename "$0") $*"\n', { mode: 0o755 });
    process.env.PATH = `${tools}${delimiter}${process.env.PATH}`;
    process.env.STIM_HOME = join(area, 'client-home');
    const client = join(area, 'client');
    mkdirSync(client);
    spawnSync('git', ['init', '--quiet', client]);
    writeNativeXcodeProject(client);
    prepareClient(client);
    const unused = () => {
      throw new Error('Identity must not prepare or compile');
    };
    const recipe = nativeXcodeIosProject(client).artifact({
      root: client,
      logFile: join(area, 'client.ndjson'),
      configuration: 'Debug',
      target: {
        udid: null,
        destination: 'generic/platform=iOS Simulator',
        sdk: 'iphonesimulator',
        arch: 'arm64',
        keyArch: 'arm64',
        offloadRuntime: () => 'iOS-26-0',
        offloadRefusal: null,
      },
      device: null,
      optimizations: { compilationCache: false, swiftCompilationCache: null, prefixMapping: false },
      cache: { read: true, write: true, remote: false },
      phase: unused,
      note: unused,
      logWriter: unused,
      estimates: unused,
      step: unused,
      setPodsMs: unused,
    });
    const identity = await recipe.identity();
    assert.equal(identity.cacheIneligible, undefined, identity.cacheIneligible);
    const request = recipe.offload.request('iOS-26-0');
    const visible = [];
    const walk = (directory, prefix) => {
      for (const name of readdirSync(directory, { withFileTypes: true })) {
        if (name.name === '.git') continue;
        const path = prefix ? `${prefix}/${name.name}` : name.name;
        if (name.isDirectory()) walk(join(directory, name.name), path);
        else {
          const content = readFileSync(join(directory, name.name));
          visible.push({ path, kind: 'file', size: content.length, sha256: sha(content) });
        }
      }
    };
    walk(client, '');
    const manifest = nativeTransferManifest(client, request.native.snapshot, visible);
    const blobs = join(area, 'blobs');
    for (const file of manifest.filter((each) => each.kind === 'file')) {
      const blob = join(blobs, file.sha256.slice(0, 2), file.sha256);
      mkdirSync(dirname(blob), { recursive: true });
      writeFileSync(blob, readFileSync(join(client, file.path)));
    }
    const job = {
      job: 'native-identity',
      area,
      blobs,
      manifest,
      platform: 'ios',
      project: '',
      packageName: null,
      isExpo: false,
      configuration: request.configuration,
      scheme: request.scheme,
      runtime: request.runtime,
      macos: null,
      android: null,
      swiftpmCache: join(area, 'swiftpm'),
      expectedFingerprint: identity.hash,
      optimizations: request.optimizations,
      native: {
        provider: 'xcode',
        sourceDigest: manifestDigest(manifest),
        cacheKey: request.native.cacheKey,
        arch: request.native.arch,
        parameters: request.native.snapshot.parameters,
      },
    };
    const result = spawnSync(process.execPath, [resolve('packages/stim-cli/dist/offload-worker.mjs'), 'build'], {
      input: JSON.stringify(job),
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, STIM_HOME: join(area, 'home'), ...workerEnv },
    });
    assert.equal(result.error, undefined);
    return {
      result,
      records: result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    };
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('native worker refuses a compiler environment the client did not key before compiling', async () => {
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'stim-native-identity-')));
  try {
    const { result, records } = await runNativeIdentityJob(area, () => {}, {
      SWIFT_ACTIVE_COMPILATION_CONDITIONS: 'WORKER_ONLY',
    });
    assert.deepEqual(
      { code: records.at(-1).code, message: records.at(-1).message },
      {
        code: 'identity-mismatch',
        message:
          'This Mac keys the native build differently in parameters.environment.SWIFT_ACTIVE_COMPILATION_CONDITIONS.',
      },
      result.stdout + result.stderr,
    );
    assert.equal(
      records.some((record) => record.phase === 'build'),
      false,
    );
    assert.equal(existsSync(join(area, 'out')), false);
  } finally {
    rmSync(area, { recursive: true, force: true });
  }
});

test('native worker keys a tracked file that matches .gitignore like the client', async () => {
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'stim-native-tracked-ignored-')));
  try {
    const { result, records } = await runNativeIdentityJob(
      area,
      (client) => {
        writeFileSync(join(client, '.gitignore'), 'Secrets.plist\n');
        writeFileSync(join(client, 'Secrets.plist'), 'tracked despite the ignore rule');
        spawnSync('git', ['-C', client, 'add', '-A']);
        spawnSync('git', ['-C', client, 'add', '-f', 'Secrets.plist']);
      },
      {},
    );
    assert.equal(
      readFileSync(join(area, 'src', 'Secrets.plist'), 'utf8'),
      'tracked despite the ignore rule',
      result.stdout + result.stderr,
    );
    assert.notEqual(records.at(-1).code, 'identity-mismatch', result.stdout + result.stderr);
    assert.equal(
      records.some((record) => record.phase === 'build'),
      true,
      result.stdout + result.stderr,
    );
  } finally {
    rmSync(area, { recursive: true, force: true });
  }
});
