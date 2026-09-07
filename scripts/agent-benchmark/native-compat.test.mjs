import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fileHash,
  collectedNativeCompatibility,
  packageHash,
  patchedHostProcess,
  patchedJsiBuild,
  prepareNativeCompatibility,
  probeNativeCompatibility,
  verifyNativeCompatibility,
} from './native-compat.mjs';

test('compatibility refuses changed package bytes, permissions, fixture patch, and executable resolution', () => {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-compat-'));
  try {
    const packagePath = join(root, 'agent-device');
    const entry = join(packagePath, 'bin/agent-device.mjs');
    const fixture = join(root, 'fixture');
    const jsi = join(fixture, 'node_modules/expo-modules-jsi/apple/scripts/build-xcframework.sh');
    mkdirSync(join(packagePath, 'bin'), { recursive: true });
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(fixture, 'node_modules/expo-modules-jsi/apple/scripts'), { recursive: true });
    writeFileSync(entry, 'entry');
    writeFileSync(join(packagePath, 'implementation.js'), 'original implementation');
    writeFileSync(jsi, 'patched JSI');
    const wrapper = join(root, 'bin/xcodebuild');
    writeFileSync(wrapper, 'wrapper');
    chmodSync(wrapper, 0o755);
    const manifest = join(root, 'manifest.json');
    writeFileSync(
      manifest,
      JSON.stringify({
        schema: 1,
        architecture: process.arch,
        agentDevicePackageSha256: packageHash(packagePath),
        xcodebuildSha256: fileHash(wrapper),
        xcodebuildMode: 0o755,
        jsiSha256: fileHash(jsi),
      }),
    );
    const hash = fileHash(manifest);
    const mode = lstatSync(entry).mode & 0o777;
    const meta = {
      preflight: {
        nativeCompatibility: { directory: root, manifestSha256: hash },
        nativeCompatibilityProbe: { processIdentity: true },
      },
    };
    assert.equal(collectedNativeCompatibility(meta, fixture).valid, true);
    assert.equal(collectedNativeCompatibility(meta, null).valid, false);
    assert.equal(collectedNativeCompatibility(meta, join(root, 'removed-worktree')).valid, false);
    assert.equal(
      collectedNativeCompatibility({ preflight: { nativeCompatibility: meta.preflight.nativeCompatibility } }, fixture)
        .valid,
      false,
    );
    assert(verifyNativeCompatibility(manifest, hash, fixture, entry));
    assert.throws(() => verifyNativeCompatibility(manifest, 'wrong', fixture, entry), /manifest hash/);
    assert.throws(() => verifyNativeCompatibility(null, hash, fixture, entry), /missing/);
    assert.throws(() => verifyNativeCompatibility(manifest, hash, fixture, wrapper), /not the compatibility package/);
    writeFileSync(join(packagePath, 'implementation.js'), 'different implementation');
    assert.equal(collectedNativeCompatibility(meta, fixture).valid, false);
    assert.throws(() => verifyNativeCompatibility(manifest, hash, fixture, entry), /package changed/);
    writeFileSync(join(packagePath, 'implementation.js'), 'original implementation');
    chmodSync(entry, 0o700);
    assert.throws(() => verifyNativeCompatibility(manifest, hash, fixture, entry), /package changed/);
    chmodSync(entry, mode);
    chmodSync(wrapper, 0o644);
    assert.throws(() => verifyNativeCompatibility(manifest, hash, fixture, entry), /wrapper changed/);
    assert.equal(collectedNativeCompatibility(meta, fixture).valid, false);
    chmodSync(wrapper, 0o755);
    writeFileSync(jsi, 'unpatched JSI');
    assert.throws(() => verifyNativeCompatibility(manifest, hash, fixture, entry), /JSI compatibility/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('package hashing permits portable internal links but rejects escaping targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-compat-links-'));
  try {
    mkdirSync(join(root, 'package'));
    writeFileSync(join(root, 'package/source'), 'source');
    symlinkSync('source', join(root, 'package/link'));
    const hash = packageHash(join(root, 'package'));
    writeFileSync(join(root, 'package/source'), 'changed source');
    assert.notEqual(packageHash(join(root, 'package')), hash);
    writeFileSync(join(root, 'outside'), 'outside');
    symlinkSync('../outside', join(root, 'package/escape'));
    assert.throws(() => packageHash(join(root, 'package')), /escapes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('version-specific patches refuse mismatches and duplicate application', () => {
  assert.throws(() => patchedHostProcess('different package'), /exactly once/);
  const source = 'xcodebuild \\\n  SWIFT_COMPILATION_MODE=wholemodule \\\n  "$@"';
  const output = patchedJsiBuild(source);
  assert.match(output, /IDEPackageSupportDisableManifestSandbox=1/);
  assert.match(output, /OTHER_SWIFT_FLAGS=\$\(inherited\) -disable-sandbox/);
  assert(output.endsWith('  "$@"'));
  assert.throws(() => patchedJsiBuild(output), /already present/);
  assert.throws(() => patchedJsiBuild('different package'), /exactly once/);
});

test(
  'patched published agent-device keeps process identity in the real sandbox',
  {
    skip: process.platform !== 'darwin' || !process.env.BENCH_COMPAT_TEST_AGENT_DEVICE_PACKAGE,
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'benchmark-compat-live-'));
    try {
      const fixture = join(root, 'fixture');
      const target = join(fixture, 'node_modules/expo-modules-jsi/apple/scripts');
      mkdirSync(target, { recursive: true });
      copyFileSync(process.env.BENCH_COMPAT_TEST_JSI_SCRIPT, join(target, 'build-xcframework.sh'));
      const source = process.env.BENCH_COMPAT_TEST_NATIVE_SOURCE;
      const prepared = prepareNativeCompatibility({
        destination: join(root, 'compat'),
        fixture,
        agentDevicePackage: process.env.BENCH_COMPAT_TEST_AGENT_DEVICE_PACKAGE,
        nativeSource: source,
        expectedNativeSourceSha256: fileHash(source),
        sourceCommit: process.env.BENCH_COMPAT_TEST_SOURCE_COMMIT,
      });
      const entry = join(root, 'compat/agent-device/bin/agent-device.mjs');
      const compatibility = verifyNativeCompatibility(prepared.path, prepared.sha256, fixture, entry);
      assert(compatibility);
      const probe = probeNativeCompatibility(compatibility, (file, args) =>
        execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', file, ...args], {
          encoding: 'utf8',
          timeout: 15_000,
          env: { ...process.env, PATH: `${join(compatibility.directory, 'bin')}:${process.env.PATH}` },
        }),
      );
      assert.equal(probe.processIdentity, true);
      assert.match(probe.xcodeVersion, /^Xcode /);
      const psStart = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], {
        encoding: 'utf8',
      }).trim();
      const script = `import assert from 'node:assert/strict';
      import {s as command,c as start,i as zombie,a as list} from ${JSON.stringify(`file://${join(root, 'compat/agent-device/dist/src/host-process.js')}`)};
      assert.equal(start(${process.pid}), ${JSON.stringify(psStart)});
      assert(command(${process.pid}));
      assert.equal(zombie(${process.pid}), false);
      assert((await list({timeoutMs:5000})).some(x => x.pid === ${process.pid}));
      console.log('patched sandbox identity passed');`;
      const output = execFileSync(
        '/usr/bin/sandbox-exec',
        ['-p', '(version 1)(allow default)', process.execPath, '--input-type=module', '-e', script],
        { encoding: 'utf8', timeout: 15_000 },
      );
      assert.match(output, /patched sandbox identity passed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
