import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retireAndroidRecording } from './recording-cleanup.mjs';

let root, runDir, ownerHome, ownerWorktree, manifest, config, calls, files, processStart, changedManifest, changedOwner;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recording-cleanup-'));
  runDir = join(root, 'run');
  ownerHome = join(root, 'home');
  ownerWorktree = join(root, 'worktree');
  for (const path of [join(runDir, 'proof'), ownerHome, ownerWorktree]) mkdirSync(path, { recursive: true });
  config = {
    projects: { [ownerWorktree]: { platforms: { android: { owned: true, avdName: 'stim-pool', consolePort: 5554 } } } },
  };
  writeFileSync(join(ownerHome, 'config.json'), JSON.stringify(config));
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({ runId: 'test', platform: 'android' }));
  writeFileSync(join(runDir, 'proof/session.mp4'), 'saved video');
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({
      runId: 'test',
      valid: true,
      recording: { valid: true },
      evidenceSha256: { recording: createHash('sha256').update('saved video').digest('hex') },
    }),
  );
  manifest = {
    version: 1,
    resourceKind: 'screen-recording',
    sessionId: 'test',
    deviceId: 'emulator-5554',
    transportMode: 'local',
    startedAt: 1,
    outputPath: '/tmp/test-session.mp4',
    chunks: [{ remotePid: '42', remoteStartTime: '100', remotePath: '/sdcard/agent-device-recording-123.mp4' }],
    completion: { backend: 'adb screenrecord', completedAt: 2, outPath: '/tmp/test-session.mp4' },
  };
  calls = [];
  files = ['agent-device-recording-active.json'];
  processStart = '200';
  changedManifest = false;
  changedOwner = false;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const adb = (args) => {
  const command = args.join(' ');
  calls.push(command);
  if (command === 'emu avd name')
    return changedOwner && calls.filter((x) => x === command).length > 1 ? 'other\nOK' : 'stim-pool\nOK';
  if (command === 'shell ls -a /sdcard') return files.join('\n');
  if (command === 'shell ls -a /data/local/tmp') return '';
  if (command === 'shell cat /sdcard/agent-device-recording-active.json')
    return JSON.stringify(
      changedManifest && calls.filter((x) => x === command).length > 1
        ? { ...manifest, sessionId: 'changed' }
        : manifest,
    );
  if (command === 'shell ls /proc') return processStart === null ? '1 2' : '1 2 42';
  if (command === 'shell cat /proc/42/stat') {
    if (processStart === 'unreadable') throw Error('permission denied');
    return `42 (binder thread) ${Array(19).fill('0').join(' ')} ${processStart}`;
  }
  if (command === 'shell rm -f /sdcard/agent-device-recording-active.json') {
    files = [];
    return '';
  }
  throw Error(`Unexpected adb call: ${command}`);
};
const retire = () => retireAndroidRecording({ runDir, ownerHome, ownerWorktree, serial: 'emulator-5554', adb });

it.each(['missing', 'reused'])(
  'retires completed metadata with saved proof and a %s recorder without signaling a process',
  (state) => {
    if (state === 'missing') processStart = null;
    expect(retire()).toEqual(['/sdcard/agent-device-recording-active.json']);
    expect(calls.filter((x) => x.includes('rm ') || x.includes('kill'))).toEqual([
      'shell rm -f /sdcard/agent-device-recording-active.json',
    ]);
    expect(JSON.parse(readFileSync(join(runDir, 'recording-retirement-sdcard.json'))).manifest).toEqual(manifest);
  },
);

it('leaves devices without recording manifests unchanged', () => {
  files = [];
  expect(retire()).toEqual([]);
  expect(calls.some((x) => x.includes('rm ') || x.includes('/proc'))).toBe(false);
});

it.each([
  'live',
  'unreadable',
  'malformed stat',
  'incomplete',
  'wrong session',
  'wrong device',
  'foreign path',
  'remaining video',
  'modified proof',
  'unowned',
  'changed owner',
  'changed manifest',
  'numeric identity',
])('refuses %s evidence without deleting metadata', (failure) => {
  if (failure === 'live') processStart = '100';
  if (failure === 'unreadable') processStart = 'unreadable';
  if (failure === 'malformed stat') processStart = 'unknown';
  if (failure === 'incomplete') delete manifest.completion;
  if (failure === 'wrong session') manifest.sessionId = 'another-run';
  if (failure === 'wrong device') manifest.deviceId = 'emulator-5556';
  if (failure === 'foreign path') manifest.chunks[0].remotePath = '/sdcard/someone-elses.mp4';
  if (failure === 'remaining video') files.push('agent-device-recording-123.mp4');
  if (failure === 'modified proof') writeFileSync(join(runDir, 'proof/session.mp4'), 'different');
  if (failure === 'unowned') {
    config.projects[ownerWorktree].platforms.android.owned = false;
    writeFileSync(join(ownerHome, 'config.json'), JSON.stringify(config));
  }
  if (failure === 'changed owner') changedOwner = true;
  if (failure === 'changed manifest') changedManifest = true;
  if (failure === 'numeric identity') manifest.chunks[0].remoteStartTime = 100;
  expect(retire).toThrow(/Android recording|permission denied/);
  expect(calls.some((x) => x.includes('rm ') || x.includes('kill'))).toBe(false);
});
