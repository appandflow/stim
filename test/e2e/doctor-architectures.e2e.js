import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectIosDebugArchitectures,
  parseIosDebugArchitectures,
} from '../../packages/stim-cli/src/doctor-ios-architectures.ts';
import { getExecutor } from '../../packages/stim-cli/src/exec.ts';

test(
  'doctor resolves inherited and SDK-conditioned Debug architecture settings with real Xcode',
  { skip: process.platform !== 'darwin' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-architectures-e2e-'));
    const previousHome = process.env.STIM_HOME;
    process.env.STIM_HOME = join(root, 'state');
    try {
      cpSync(fileURLToPath(new URL('../fixtures/doctor-architectures/ios', import.meta.url)), join(root, 'ios'), {
        recursive: true,
      });
      const findings = inspectIosDebugArchitectures(root);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].code, 'ios-debug-architectures');
      assert.match(findings[0].detail, /NativePod \(arm64, x86_64\)/);
      assert.doesNotMatch(findings[0].detail, /App \(/);

      const release = getExecutor().runFile(
        'xcodebuild',
        [
          '-project',
          join(root, 'ios', 'Architecture.xcodeproj'),
          '-alltargets',
          '-configuration',
          'Release',
          '-sdk',
          'iphonesimulator',
          '-showBuildSettings',
          '-json',
          '-disableAutomaticPackageResolution',
          '-skipPackageUpdates',
        ],
        { timeoutMs: 15_000 },
      );
      assert.equal(parseIosDebugArchitectures(release).affected.length, 0);
      assert.equal(
        JSON.parse(release).find((target) => target.target === 'NativePod').buildSettings.ONLY_ACTIVE_ARCH,
        'NO',
      );

      writeFileSync(
        join(root, 'ios', 'Debug.xcconfig'),
        'ONLY_ACTIVE_ARCH = NO\nEXCLUDED_ARCHS[sdk=iphonesimulator*] = x86_64\n',
      );
      assert.deepEqual(inspectIosDebugArchitectures(root), []);
      writeFileSync(join(root, 'ios', 'Debug.xcconfig'), 'ONLY_ACTIVE_ARCH = $(inherited)\n');
      assert.deepEqual(inspectIosDebugArchitectures(root), []);
    } finally {
      if (previousHome === undefined) delete process.env.STIM_HOME;
      else process.env.STIM_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
