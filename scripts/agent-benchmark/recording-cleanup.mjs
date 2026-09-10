import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

export function retireAndroidRecording({ runDir, ownerHome, ownerWorktree, serial, adb }) {
  const verifyOwner = () => {
    const projects = read(join(ownerHome, 'config.json')).projects ?? {};
    const project = Object.entries(projects).find(([path]) => realpathSync(path) === realpathSync(ownerWorktree))?.[1];
    const device = project?.platforms?.android;
    if (
      device?.owned !== true ||
      !device.avdName?.startsWith('stim-') ||
      serial !== `emulator-${device.consolePort}` ||
      adb(['emu', 'avd', 'name']).trim().split(/\r?\n/)[0] !== device.avdName
    )
      throw new Error('Android recording cleanup cannot prove emulator ownership');
  };
  verifyOwner();
  const retired = [];
  for (const directory of ['/sdcard', '/data/local/tmp']) {
    const listing = () => adb(['shell', 'ls', '-a', directory]).trim().split(/\s+/);
    const path = `${directory}/agent-device-recording-active.json`;
    if (!listing().includes('agent-device-recording-active.json')) continue;
    const text = adb(['shell', 'cat', path]);
    const manifest = JSON.parse(text);
    const record = read(join(runDir, 'run.json'));
    const meta = read(join(runDir, 'meta.json'));
    if (
      record.valid !== true ||
      record.recording?.valid !== true ||
      meta.platform !== 'android' ||
      meta.runId !== record.runId ||
      manifest.version !== 1 ||
      manifest.resourceKind !== 'screen-recording' ||
      manifest.sessionId !== (meta.agentDevice?.session ?? meta.runId) ||
      manifest.deviceId !== serial ||
      manifest.transportMode !== 'local' ||
      manifest.pendingRemotePath !== undefined ||
      manifest.completion?.backend !== 'adb screenrecord' ||
      !Number.isFinite(manifest.startedAt) ||
      !Number.isFinite(manifest.completion.completedAt) ||
      manifest.completion.completedAt < manifest.startedAt ||
      manifest.outputPath !== `/tmp/${meta.runId}-session.mp4` ||
      manifest.completion.outPath !== manifest.outputPath ||
      !Array.isArray(manifest.chunks) ||
      !manifest.chunks.length ||
      hash(readFileSync(join(runDir, 'proof', 'session.mp4'))) !== record.evidenceSha256?.recording
    )
      throw new Error('Android recording cleanup requires a completed benchmark recording with saved proof');
    const verifyEnded = () => {
      const processes = new Set(adb(['shell', 'ls', '/proc']).trim().split(/\s+/));
      const files = listing();
      for (const chunk of manifest.chunks) {
        const name = chunk.remotePath?.slice(directory.length + 1);
        if (
          typeof chunk.remotePid !== 'string' ||
          !/^\d+$/.test(chunk.remotePid) ||
          typeof chunk.remoteStartTime !== 'string' ||
          !/^\d+$/.test(chunk.remoteStartTime) ||
          !chunk.remotePath?.startsWith(`${directory}/`) ||
          !/^agent-device-recording-\d+\.mp4$/.test(name ?? '') ||
          files.includes(name)
        )
          throw new Error('Android recording cleanup cannot retire a chunk with remaining or unknown artifacts');
        if (!processes.has(chunk.remotePid)) continue;
        const stat = adb(['shell', 'cat', `/proc/${chunk.remotePid}/stat`]);
        const end = stat.lastIndexOf(')');
        const start =
          end < 0
            ? null
            : stat
                .slice(end + 1)
                .trim()
                .split(/\s+/)[19];
        if (!stat.startsWith(`${chunk.remotePid} (`) || !/^\d+$/.test(start ?? '') || start === chunk.remoteStartTime)
          throw new Error('Android recording cleanup cannot prove the original recorder has ended');
      }
    };
    verifyEnded();
    const evidence = { checkedAt: new Date().toISOString(), serial, path, manifestSha256: hash(text), manifest };
    writeFileSync(
      join(runDir, `recording-retirement-${directory === '/sdcard' ? 'sdcard' : 'tmp'}.json`),
      JSON.stringify(evidence, null, 2),
    );
    verifyOwner();
    if (adb(['shell', 'cat', path]) !== text) throw new Error('Android recording manifest changed during cleanup');
    verifyEnded();
    adb(['shell', 'rm', '-f', path]);
    if (listing().includes('agent-device-recording-active.json'))
      throw new Error('Android recording manifest remains after cleanup');
    retired.push(path);
  }
  return retired;
}
