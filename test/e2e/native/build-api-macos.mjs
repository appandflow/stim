import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStim } from '../../../packages/stim-cli/dist/api.mjs';
import { buildCI } from '../../../packages/ci/dist/index.mjs';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-build-api-')));
const root = join(scratch, 'project');
const home = join(scratch, 'home');
const artifacts = process.env.STIM_BUILD_QA_ARTIFACTS;
assert.ok(artifacts, 'An explicit evidence directory is required');
mkdirSync(artifacts, { recursive: true });
mkdirSync(join(root, 'Sources', 'Probe'), { recursive: true });
writeFileSync(
  join(root, 'Package.swift'),
  `// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "Probe", platforms: [.macOS(.v13)], products: [.executable(name: "Probe", targets: ["Probe"])], targets: [.executableTarget(name: "Probe")])
`,
);
writeFileSync(join(root, '.stim.json'), JSON.stringify({ macos: { product: 'Probe', infoPlist: 'Info.plist' } }));
writeFileSync(
  join(root, 'Info.plist'),
  `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.stim.buildprobe</string><key>CFBundleExecutable</key><string>Probe</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleName</key><string>Probe</string></dict></plist>`,
);
const source = join(root, 'Sources', 'Probe', 'main.swift');
writeFileSync(source, 'import AppKit\nlet app = NSApplication.shared\napp.setActivationPolicy(.regular)\napp.run()\n');
const stim = createStim({ projectRoot: root, home, onProgress: ({ message }) => process.stderr.write(message) });
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const identity = (pid) =>
  execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=,comm='], { encoding: 'utf8', timeout: 5000 }).trim();
function identityOrAbsent(pid) {
  try {
    return identity(pid);
  } catch (error) {
    if (error.status !== 1) throw error;
    return '';
  }
}
const evidence = {};
let failure;
const describeError = (error) => ({ message: error.message, stack: error.stack });
try {
  const running = await stim.run({ platform: 'macos', remoteBuild: 'local' });
  assert.equal(running.facts.launched, true);
  assert.ok(running.facts.pid > 0);
  evidence.running = running;
  const before = identity(running.facts.pid);
  const original = hash(running.facts.executable);
  const first = await stim.build({ platform: 'macos', remoteBuild: 'local' });
  evidence.first = first;
  assert.equal(first.facts.build.state, 'ok');
  assert.notEqual(first.facts.bundle, running.facts.bundle);
  const retained = hash(first.facts.executable);
  assert.equal(identity(running.facts.pid), before);
  assert.equal(hash(running.facts.executable), original);
  writeFileSync(
    source,
    'import AppKit\nprint("changed build output")\nlet app = NSApplication.shared\napp.setActivationPolicy(.regular)\napp.run()\n',
  );
  const built = await buildCI({
    projectRoot: root,
    home,
    build: { platform: 'macos', remoteBuild: 'local' },
    artifactsDir: join(artifacts, 'build'),
    timeoutMs: 180_000,
  });
  evidence.exported = built;
  assert.equal(built.exitCode, 0);
  const extracted = join(scratch, 'extracted');
  mkdirSync(extracted);
  execFileSync('tar', ['-xzf', built.artifactPath, '-C', extracted], { timeout: 30_000 });
  const executable = join(extracted, 'Probe.app', 'Contents', 'MacOS', 'Probe');
  assert.notEqual(hash(executable), retained);
  execFileSync('codesign', ['--verify', '--strict', join(extracted, 'Probe.app')], { timeout: 30_000 });
  assert.equal(hash(first.facts.executable), retained);
  assert.equal(hash(running.facts.executable), original);
  assert.equal(identity(running.facts.pid), before);
  evidence.preservedRuntime = true;
} catch (error) {
  evidence.failure = describeError(error);
  failure = error;
} finally {
  try {
    try {
      evidence.cleanup = await stim.stop({ signal: AbortSignal.timeout(60_000) });
      assert.equal(evidence.cleanup.ok, true);
      if (evidence.running) {
        const current = identityOrAbsent(evidence.running.facts.pid);
        assert.equal(current, '', 'The exact owned app must exit during cleanup');
      }
      evidence.cleanupVerified = true;
    } catch (error) {
      evidence.cleanupError = describeError(error);
      failure ??= error;
    }
    try {
      evidence.diagnostics = await stim.diagnostics({ tail: 1000, signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      evidence.diagnosticsError = describeError(error);
      failure ??= error;
    }
    if (evidence.cleanupVerified && !evidence.diagnosticsError) rmSync(scratch, { recursive: true, force: true });
  } catch (error) {
    evidence.cleanupError ??= describeError(error);
    failure ??= error;
  } finally {
    writeFileSync(join(artifacts, 'summary.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  }
}
if (failure) throw failure;
