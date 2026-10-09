import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectedNativeCompatibility, fileHash, verifyNativeCompatibilityTools } from './native-compat.mjs';
import { commandCompletedBefore, sameLiteralShellCommand, shellCommandSegments } from './run-guards.mjs';

export function prepareCompatibilityProof({ runId, worktree, runDir, compatibility }) {
  if (!compatibility) return null;
  const helper = fileURLToPath(new URL('./native-compat.mjs', import.meta.url));
  const node = realpathSync.native(process.execPath);
  const input = {
    runId,
    worktree,
    manifest: join(compatibility.directory, 'manifest.json'),
    manifestSha256: compatibility.manifestSha256,
    agentDeviceBin: join(compatibility.directory, 'agent-device/bin/agent-device.mjs'),
    screenshot: join(runDir, 'proof/settings.png'),
    recording: join(runDir, 'proof/session.mp4'),
  };
  return {
    input,
    helper,
    helperSha256: fileHash(helper),
    node,
    nodeSha256: fileHash(node),
    command: [node, helper, 'proof', JSON.stringify(input)]
      .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
      .join(' '),
  };
}

function recordedNativeBuild(command) {
  return shellCommandSegments(command).some((part) =>
    /(?:^|\s)(?:stim\s+(?:ios|android)\b|(?:npx\s+)?(?:\S*\/)?expo\s+run:(?:ios|android)\b|(?:\S*\/)?(?:gradlew?|xcodebuild)(?:\s|$)|(?:node\s+)?\S*expo\/bin\/cli\s+run:(?:ios|android)\b)/.test(
      part,
    ),
  );
}

function verifyProofTools(expected) {
  if (fileHash(expected.helper) !== expected.helperSha256 || fileHash(expected.node) !== expected.nodeSha256)
    throw new Error('compatibility proof helper or Node changed');
  const input = expected.input;
  verifyNativeCompatibilityTools(input.manifest, input.manifestSha256, input.agentDeviceBin);
}

export function compatibilityProofEvidence(meta, worktree, commands, screen, recording) {
  const expected = meta.compatibilityProof;
  if (!expected) return collectedNativeCompatibility(meta, worktree);
  try {
    const compatibility = meta.preflight?.nativeCompatibility;
    const input = expected.input;
    if (!worktree || !existsSync(worktree)) {
      verifyProofTools(expected);
      return collectedNativeCompatibility(meta, worktree);
    }
    if (
      !meta.preflight?.nativeCompatibilityProbe?.processIdentity ||
      !screen.valid ||
      !recording.valid ||
      input.runId !== meta.runId ||
      input.manifest !== join(compatibility.directory, 'manifest.json') ||
      input.manifestSha256 !== compatibility.manifestSha256 ||
      input.screenshot !== screen.target ||
      input.recording !== recording.target ||
      realpathSync.native(input.worktree) !== realpathSync.native(worktree)
    )
      throw new Error('compatibility proof does not match this run and its selected media');
    const copy = commands.find((entry) => entry.id === screen.recordingCopyCommandId);
    const close = commands.find((entry) => entry.id === screen.closeCommandId);
    const command = commands.find(
      (entry) =>
        entry.exitCode === 0 &&
        sameLiteralShellCommand(entry.command, expected.command) &&
        copy &&
        close &&
        commandCompletedBefore(copy, entry) &&
        commandCompletedBefore(entry, close),
    );
    if (!command) throw new Error('successful awaited compatibility proof command missing');
    const receipt = JSON.parse(command.output);
    if (
      receipt.schema !== 1 ||
      JSON.stringify(receipt.input) !== JSON.stringify(input) ||
      receipt.worktree !== realpathSync.native(worktree) ||
      receipt.helperSha256 !== expected.helperSha256 ||
      receipt.nodeSha256 !== expected.nodeSha256 ||
      receipt.screenshotSha256 !== fileHash(screen.target) ||
      receipt.recordingSha256 !== fileHash(recording.target)
    )
      throw new Error('compatibility proof receipt or pinned bytes changed');
    if (commands.some((entry) => recordedNativeBuild(entry.command) && !commandCompletedBefore(entry, command)))
      throw new Error('native build recorded after compatibility proof');
    verifyProofTools(expected);
    if (lstatSync(join(worktree, 'node_modules'), { throwIfNoEntry: false })) {
      const current = collectedNativeCompatibility(meta, worktree);
      if (!current?.valid) throw new Error(current?.reason ?? 'live compatibility missing');
    }
    return {
      valid: true,
      manifestSha256: input.manifestSha256,
      commandId: command.id,
      startedAt: command.startedAt,
      observedAt: command.endedAt,
      recordingCopyCommandId: copy.id,
      receipt,
    };
  } catch (error) {
    return { valid: false, reason: error.message };
  }
}
