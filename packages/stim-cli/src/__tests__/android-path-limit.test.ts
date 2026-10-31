import { expect, test } from 'vitest';
import { GESTURE_HANDLER_OBJECT, androidPathRoom } from '../engine/android-path-limit.ts';

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
