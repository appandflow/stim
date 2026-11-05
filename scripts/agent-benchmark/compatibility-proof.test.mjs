import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compatibilityProofEvidence, prepareCompatibilityProof } from './compatibility-proof.mjs';
import { fileHash, packageHash } from './native-compat.mjs';

test.skipIf(process.platform === 'win32')(
  'awaited compatibility evidence survives immediate dependency removal but refuses changed or unrelated proof (POSIX executable-mode contract)',
  () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'benchmark-proof-')));
    try {
      const fixture = join(root, 'worktree');
      const runDir = join(root, 'run');
      const packagePath = join(root, 'agent-device');
      const entry = join(packagePath, 'bin/agent-device.mjs');
      const jsi = join(fixture, 'node_modules/expo-modules-jsi/apple/scripts/build-xcframework.sh');
      const wrapper = join(root, 'bin/xcodebuild');
      for (const directory of [
        join(packagePath, 'bin'),
        join(root, 'bin'),
        join(fixture, 'node_modules/expo-modules-jsi/apple/scripts'),
        join(runDir, 'proof'),
      ]) {
        mkdirSync(directory, { recursive: true });
      }
      writeFileSync(entry, 'entry');
      writeFileSync(wrapper, 'wrapper');
      chmodSync(wrapper, 0o755);
      writeFileSync(jsi, 'patched JSI');
      const screenshot = join(runDir, 'proof/settings.png');
      const video = join(runDir, 'proof/session.mp4');
      writeFileSync(screenshot, 'independently validated screenshot');
      writeFileSync(video, 'independently validated recording');
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
      renameSync(join(fixture, 'node_modules'), join(root, 'dependencies'));
      symlinkSync(join(root, 'dependencies'), join(fixture, 'node_modules'));
      const compatibility = { directory: root, manifestSha256: fileHash(manifest) };
      const proof = prepareCompatibilityProof({ runId: 'run-1', worktree: fixture, runDir, compatibility });
      const meta = {
        runId: 'run-1',
        compatibilityProof: proof,
        preflight: {
          nativeCompatibility: compatibility,
          nativeCompatibilityProbe: { processIdentity: true },
        },
      };
      const output = execFileSync(proof.node, [proof.helper, 'proof', JSON.stringify(proof.input)], {
        encoding: 'utf8',
      });
      rmSync(join(fixture, 'node_modules'));
      const commands = [
        {
          id: 'copy',
          command: 'cp recording session.mp4',
          exitCode: 0,
          startedAt: '2026-10-09T12:00:01Z',
          endedAt: '2026-10-09T12:00:02Z',
        },
        {
          id: 'verify',
          command: proof.command,
          exitCode: 0,
          output,
          startedAt: '2026-10-09T12:00:03Z',
          endedAt: '2026-10-09T12:00:04Z',
        },
        {
          id: 'close',
          command: 'agent-device close',
          exitCode: 0,
          startedAt: '2026-10-09T12:00:05Z',
          endedAt: '2026-10-09T12:00:06Z',
        },
      ];
      const screen = { valid: true, target: screenshot, recordingCopyCommandId: 'copy', closeCommandId: 'close' };
      const recording = { valid: true, target: video };
      const collect = (entries = commands, metadata = meta, selectedScreen = screen, selectedRecording = recording) =>
        compatibilityProofEvidence(metadata, fixture, entries, selectedScreen, selectedRecording);
      expect(collect()).toMatchObject({
        valid: true,
        commandId: 'verify',
        observedAt: commands[1].endedAt,
        recordingCopyCommandId: 'copy',
      });
      expect(
        collect([commands[0], { ...commands[1], command: proof.command.replace("'proof'", '"proof"') }, commands[2]])
          .valid,
      ).toBe(true);
      const buffered = commands.map((command, index) => ({
        ...command,
        startedAt: '2026-10-09T12:00:03Z',
        endedAt: '2026-10-09T12:00:03Z',
        startEventOffset: 10 + index * 2,
        endEventOffset: 11 + index * 2,
      }));
      expect(collect(buffered).valid).toBe(true);
      for (const changed of [{ startEventOffset: 11 }, { endEventOffset: 14 }, { parallelTimingAmbiguous: true }]) {
        expect(collect([buffered[0], { ...buffered[1], ...changed }, buffered[2]]).valid).toBe(false);
      }
      const priorBuild = {
        ...buffered[0],
        id: 'build',
        command: './gradlew assembleDebug',
        startEventOffset: 8,
        endEventOffset: 9,
      };
      expect(collect([priorBuild, ...buffered]).valid).toBe(true);
      expect(collect([{ ...priorBuild, endEventOffset: 13 }, ...buffered]).valid).toBe(false);
      expect(collect(commands, { ...meta, compatibilityProof: undefined }).valid).toBe(false);
      expect(collect(commands, meta, { ...screen, valid: false }).valid).toBe(false);
      expect(collect(commands, meta, screen, { ...recording, valid: false }).valid).toBe(false);
      expect(collect(commands, { ...meta, runId: 'other' }).valid).toBe(false);
      for (const changed of [
        { command: `echo ${JSON.stringify(output)}` },
        { command: `${proof.command} && true` },
        { command: proof.command.replace('run-1', 'other') },
        { exitCode: 1 },
        { output: '{' },
        { output: '{}' },
        { startedAt: commands[0].startedAt },
        { endedAt: commands[2].endedAt },
      ]) {
        expect(collect([commands[0], { ...commands[1], ...changed }, commands[2]]).valid).toBe(false);
      }
      const receipt = JSON.parse(output);
      for (const changed of [
        { input: { ...receipt.input, runId: 'other' } },
        { input: { ...receipt.input, manifestSha256: 'changed' } },
        { worktree: root },
        { helperSha256: 'changed' },
        { nodeSha256: 'changed' },
        { screenshotSha256: 'changed' },
        { recordingSha256: 'changed' },
      ]) {
        expect(
          collect([commands[0], { ...commands[1], output: JSON.stringify({ ...receipt, ...changed }) }, commands[2]])
            .valid,
        ).toBe(false);
      }
      for (const command of [
        'stim android',
        'stim ios',
        './gradlew assembleDebug',
        'xcodebuild -project App',
        'npx expo run:android',
        './node_modules/.bin/expo run:ios',
      ]) {
        expect(
          collect([
            ...commands,
            { id: 'later', command, startedAt: '2026-10-09T12:00:07Z', endedAt: '2026-10-09T12:00:08Z' },
          ]).valid,
        ).toBe(false);
        expect(
          collect([
            ...commands,
            { id: 'overlap', command, startedAt: '2026-10-09T12:00:01Z', endedAt: '2026-10-09T12:00:04Z' },
          ]).valid,
        ).toBe(false);
      }
      writeFileSync(video, 'different recording');
      expect(collect().valid).toBe(false);
      writeFileSync(video, 'independently validated recording');
      writeFileSync(entry, 'changed tool');
      expect(collect().valid).toBe(false);
      writeFileSync(entry, 'entry');
      symlinkSync(join(root, 'dependencies'), join(fixture, 'node_modules'));
      expect(collect().valid).toBe(true);
      writeFileSync(jsi, 'changed JSI');
      expect(collect().valid).toBe(false);
      expect(() =>
        execFileSync(proof.node, [proof.helper, 'proof', JSON.stringify(proof.input)], { stdio: 'pipe' }),
      ).toThrow(/ExpoModulesJSI compatibility patch/);
      writeFileSync(jsi, 'patched JSI');
      const originalManifest = readFileSync(manifest);
      writeFileSync(manifest, 'changed manifest');
      expect(collect().valid).toBe(false);
      writeFileSync(manifest, originalManifest);
      rmSync(fixture, { recursive: true });
      expect(compatibilityProofEvidence(meta, fixture, commands, screen, recording)).toMatchObject({
        valid: false,
        reason: 'run worktree missing for compatibility validation',
        manifestSha256: compatibility.manifestSha256,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
