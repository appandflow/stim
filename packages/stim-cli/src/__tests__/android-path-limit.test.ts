import { expect, test } from 'vitest';
import {
  ANDROID_OBJECT_PATH_MAX,
  LONGEST_ANDROID_OBJECT_PATH_TAIL,
  androidPathRoom,
  androidPathRoomMessage,
  androidPathRoomRemedy,
} from '../engine/android-path-limit.ts';
import { checkAndroidPathRoom } from '../diagnostics/doctor.ts';

const rootOf = (length: number) => `D:\\${'a'.repeat(length - 3)}`;
const maxRoot = (abi: string) => ANDROID_OBJECT_PATH_MAX - 1 - LONGEST_ANDROID_OBJECT_PATH_TAIL - abi.length;

test('the e2e fixture builds at its 33-character CI root and fails at the 36-character root measured on the debug host', () => {
  expect(androidPathRoom('D:\\e\\sn-36AFO0\\e2e-1-1c17ed8f9e83', { abi: 'x86_64', platform: 'win32' })).toBeNull();
  const room = androidPathRoom('D:\\a\\stim\\stim\\e2e-tmp\\sn-nBa2Bi\\app', { abi: 'x86_64', platform: 'win32' });
  expect(room).toEqual({
    root: 'D:\\a\\stim\\stim\\e2e-tmp\\sn-nBa2Bi\\app',
    abi: 'x86_64',
    longest: ANDROID_OBJECT_PATH_MAX,
    maxRootLength: 35,
  });
});

test('the last root that fits is one character shorter than the one that reaches the limit', () => {
  const abi = 'x86_64';
  expect(androidPathRoom(rootOf(maxRoot(abi)), { abi, platform: 'win32' })).toBeNull();
  expect(androidPathRoom(rootOf(maxRoot(abi) + 1), { abi, platform: 'win32' })?.longest).toBe(ANDROID_OBJECT_PATH_MAX);
});

test('release variants account for the longer RelWithDebInfo directory', () => {
  const abi = 'x86_64';
  const releaseRoot = maxRoot(abi) - ('RelWithDebInfo'.length - 'Debug'.length);
  expect(androidPathRoom(rootOf(releaseRoot), { abi, variant: 'productionRelease', platform: 'win32' })).toBeNull();
  expect(
    androidPathRoom(rootOf(releaseRoot + 1), { abi, variant: 'productionRelease', platform: 'win32' })?.longest,
  ).toBe(ANDROID_OBJECT_PATH_MAX);
  expect(androidPathRoom(rootOf(maxRoot(abi)), { abi, variant: 'productionDebug', platform: 'win32' })).toBeNull();
});

test('a build for every ABI has to fit the longest ABI name', () => {
  const root = rootOf(maxRoot('x86_64'));
  expect(androidPathRoom(root, { abi: 'x86_64', platform: 'win32' })).toBeNull();
  const room = androidPathRoom(root, { abi: null, platform: 'win32' });
  expect(room?.abi).toBe('armeabi-v7a');
  expect(room?.maxRootLength).toBe(maxRoot('armeabi-v7a'));
});

test('only win32 has the limit', () => {
  const long = rootOf(200);
  expect(androidPathRoom(long, { platform: 'darwin' })).toBeNull();
  expect(androidPathRoom(long, { platform: 'linux' })).toBeNull();
  expect(androidPathRoom(long, { platform: 'win32' })).not.toBeNull();
});

test('the message names the root, its length, the ABI and the root cap; the remedy names subst', () => {
  const root = rootOf(maxRoot('x86_64') + 12);
  const room = androidPathRoom(root, { abi: 'x86_64', platform: 'win32' });
  expect(room).not.toBeNull();
  expect(androidPathRoomMessage(room!)).toBe(
    `The project root ${root} is ${root.length} characters, so the longest known Android native object path ` +
      `(react_codegen_safeareacontext for x86_64) reaches ${ANDROID_OBJECT_PATH_MAX + 11} characters, past the ` +
      `${ANDROID_OBJECT_PATH_MAX - 1} the NDK's ninja can be given on Windows; the root can be at most 35 characters.`,
  );
  expect(androidPathRoomRemedy(room!)).toBe(
    `Map the project to a drive letter (\`subst X: "${root}"\`) and run Stim from X:\\, or move it under a shorter root.`,
  );
  const spacedRoot = `${root} folder`;
  const spacedRoom = androidPathRoom(spacedRoot, { abi: 'x86_64', platform: 'win32' });
  expect(androidPathRoomRemedy(spacedRoom!)).toContain(`subst X: "${spacedRoot}"`);
});

test('doctor reports the room as an Android cost finding on win32 only, for the emulator ABI', () => {
  const root = rootOf(maxRoot('x86_64') + 5);
  expect(checkAndroidPathRoom(root, 'android', 'darwin', 'x64')).toBeNull();
  expect(checkAndroidPathRoom(root, 'ios', 'win32', 'x64')).toBeNull();
  expect(checkAndroidPathRoom(rootOf(maxRoot('x86_64')), undefined, 'win32', 'x64')).toBeNull();
  const finding = checkAndroidPathRoom(root, undefined, 'win32', 'x64');
  expect(finding?.code).toBe('android-path-room');
  expect(finding?.level).toBe('cost');
  expect(finding?.title).toBe('The project path leaves no room for Android native object paths');
  expect(finding?.detail).toContain(`${root} is ${root.length} characters`);
  expect(finding?.detail).toContain('for x86_64');
  expect(finding?.detail).toContain('STIM_PATH_TOO_LONG');
  expect(finding?.fix).toContain(`subst X: "${root}"`);
});

test('doctor uses the Windows ARM64 emulator ABI when checking path room', () => {
  const root = rootOf(maxRoot('arm64-v8a') + 2);
  expect(checkAndroidPathRoom(root, 'android', 'win32', 'x64')).toBeNull();
  const finding = checkAndroidPathRoom(root, 'android', 'win32', 'arm64');
  expect(finding?.detail).toContain('for arm64-v8a');
  expect(finding?.detail).toContain('STIM_PATH_TOO_LONG');
});
