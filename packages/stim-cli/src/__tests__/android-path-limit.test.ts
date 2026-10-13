import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  ANDROID_OBJECT_PATH_MAX,
  GESTURE_HANDLER_OBJECT,
  SAFE_AREA_CONTEXT_OBJECT,
  androidPathRoom,
  androidPathRoomMessage,
  androidPathRoomRemedy,
  longestAndroidObject,
} from '../engine/android-path-limit.ts';
import { checkAndroidPathRoom } from '../diagnostics/doctor.ts';

const rootOf = (length: number) => `D:\\${'a'.repeat(length - 3)}`;
const maxRoot = (abi: string) => ANDROID_OBJECT_PATH_MAX - 2 - SAFE_AREA_CONTEXT_OBJECT.tail - abi.length;

test('the e2e fixture builds at its 33-character CI root', () => {
  expect(androidPathRoom('D:\\e\\sn-36AFO0\\e2e-1-1c17ed8f9e83', { abi: 'x86_64', platform: 'win32' })).toBeNull();
});

test('react-native-gesture-handler 3 builds at the 24-character root measured on Windows and refuses the 25-character one that failed', () => {
  const object = GESTURE_HANDLER_OBJECT;
  expect(androidPathRoom('C:\\src\\trailhead-abcdefg', { abi: 'x86_64', platform: 'win32', object })).toBeNull();
  expect(androidPathRoom('C:\\stimw\\954971c6', { abi: 'arm64-v8a', platform: 'win32', object })).toBeNull();
  const root = 'C:\\src\\trailhead-abcdefgh';
  expect(androidPathRoom(root, { abi: 'x86_64', platform: 'win32', object })).toEqual({
    root,
    abi: 'x86_64',
    target: 'react_codegen_rngesturehandler_codegen',
    longest: 239,
    maxRootLength: 24,
  });
});

test('the gesture handler object applies only where its shared shadow nodes resolve from the project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stim-path-room-'));
  try {
    const app = join(dir, 'apps', 'mobile');
    mkdirSync(app, { recursive: true });
    expect(longestAndroidObject(app)).toBe(SAFE_AREA_CONTEXT_OBJECT);
    const gestureHandler = join(dir, 'node_modules', 'react-native-gesture-handler');
    mkdirSync(join(gestureHandler, 'src'), { recursive: true });
    writeFileSync(join(gestureHandler, 'package.json'), '{}');
    expect(longestAndroidObject(app)).toBe(SAFE_AREA_CONTEXT_OBJECT);
    mkdirSync(join(gestureHandler, 'shared', 'shadowNodes'), { recursive: true });
    expect(longestAndroidObject(app)).toBe(GESTURE_HANDLER_OBJECT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the last root that fits is one character shorter than the one that reaches the limit', () => {
  const abi = 'x86_64';
  expect(androidPathRoom(rootOf(maxRoot(abi)), { abi, platform: 'win32' })).toBeNull();
  expect(androidPathRoom(rootOf(maxRoot(abi) + 1), { abi, platform: 'win32' })?.longest).toBe(
    ANDROID_OBJECT_PATH_MAX - 1,
  );
});

test('release variants account for the longer RelWithDebInfo directory', () => {
  const abi = 'x86_64';
  const releaseRoot = maxRoot(abi) - ('RelWithDebInfo'.length - 'Debug'.length);
  expect(androidPathRoom(rootOf(releaseRoot), { abi, variant: 'productionRelease', platform: 'win32' })).toBeNull();
  expect(
    androidPathRoom(rootOf(releaseRoot + 1), { abi, variant: 'productionRelease', platform: 'win32' })?.longest,
  ).toBe(ANDROID_OBJECT_PATH_MAX - 1);
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

test('the message names the root, its length, the object, the ABI and the root cap; the remedy names a short real path', () => {
  const root = rootOf(maxRoot('x86_64') + 12);
  const room = androidPathRoom(root, { abi: 'x86_64', platform: 'win32' });
  expect(room).not.toBeNull();
  expect(androidPathRoomMessage(room!)).toBe(
    `The project root ${root} is ${root.length} characters, so the longest known Android native object path ` +
      `(react_codegen_safeareacontext for x86_64) reaches ${ANDROID_OBJECT_PATH_MAX + 10} characters, past the ` +
      `${ANDROID_OBJECT_PATH_MAX - 2} CMake can shorten it to for the NDK's ninja on Windows; the root can be at most ${maxRoot('x86_64')} characters.`,
  );
  const remedy = androidPathRoomRemedy(room!);
  expect(remedy).toContain(`at most ${maxRoot('x86_64')} characters, such as C:\\src\\<name>`);
  expect(remedy).not.toContain('subst X:');
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
  expect(finding?.fix).toContain(`at most ${maxRoot('x86_64')} characters`);
});

test('doctor uses the Windows ARM64 emulator ABI when checking path room', () => {
  const root = rootOf(maxRoot('arm64-v8a') + 2);
  expect(checkAndroidPathRoom(root, 'android', 'win32', 'x64')).toBeNull();
  const finding = checkAndroidPathRoom(root, 'android', 'win32', 'arm64');
  expect(finding?.detail).toContain('for arm64-v8a');
  expect(finding?.detail).toContain('STIM_PATH_TOO_LONG');
});
