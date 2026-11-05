import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolvePackageJson } from '../workspace/project-files.ts';

/**
 * The NDK's ninja is not long-path aware, so every object path it opens has to stay under Windows'
 * MAX_PATH. CMake names the object for a source outside its source directory after that source's
 * mangled absolute path, so a React Native codegen object carries the project root twice unless
 * CMake shortens it, and CMake shortens (hashes the leading directories of) an object name only
 * while the result stays under CMAKE_OBJECT_PATH_MAX; past that it keeps the full name, which
 * ninja then cannot create. `shim/android-optimizations.gradle` sets that maximum on Windows.
 * https://github.com/appandflow/stim/issues/893
 */
const ANDROID_OBJECT_PATH_MAX = 240;

/**
 * CMake's single-config Ninja generator measures an object against CMAKE_OBJECT_PATH_MAX from
 * `<target>.dir/./`, two characters longer than the directory the object is written to, so a
 * shortened object path fits only up to this length.
 * https://github.com/Kitware/CMake/blob/v3.22.1/Source/cmGlobalNinjaGenerator.cxx#L1005-L1013
 */
const LONGEST_SHORTENED_OBJECT_PATH = ANDROID_OBJECT_PATH_MAX - './'.length;

export interface AndroidLongestObject {
  target: string;
  /** Characters the shortened object path adds to the project root and the ABI name. */
  tail: number;
}

/**
 * `\android\app\.cxx\<4 hex>\Debug\<8 chars>\<abi>\safeareacontext_autolinked_build/CMakeFiles/react_codegen_safeareacontext.dir/<md5>/RNCSafeAreaViewShadowNode.cpp.o`,
 * measured on the bare e2e fixture and on trailhead (Expo SDK 58, RN 0.88).
 */
const SAFE_AREA_CONTEXT_OBJECT: AndroidLongestObject = { target: 'react_codegen_safeareacontext', tail: 181 };

/**
 * react-native-gesture-handler 3 compiles shadow nodes from its `shared/shadowNodes` directory into
 * its codegen library:
 * `\android\app\.cxx\<4 hex>\Debug\<8 chars>\<abi>\rngesturehandler_codegen_autolinked_build/CMakeFiles/react_codegen_rngesturehandler_codegen.dir/<md5>/RNGestureHandlerDetectorShadowNode.cpp.o`,
 * measured on trailhead. https://github.com/appandflow/stim/issues/3641
 */
export const GESTURE_HANDLER_OBJECT: AndroidLongestObject = {
  target: 'react_codegen_rngesturehandler_codegen',
  tail: 208,
};

function longestAndroidObject(root: string): AndroidLongestObject {
  const gestureHandler = resolvePackageJson(root, 'react-native-gesture-handler');
  return gestureHandler && existsSync(join(dirname(gestureHandler), 'shared', 'shadowNodes'))
    ? GESTURE_HANDLER_OBJECT
    : SAFE_AREA_CONTEXT_OBJECT;
}

/** The ABI name a build for every ABI has to fit; `stim android` narrows a build to the device's. */
const LONGEST_ANDROID_ABI = 'armeabi-v7a';

export interface AndroidPathRoom {
  root: string;
  abi: string;
  target: string;
  longest: number;
  maxRootLength: number;
}

export function androidPathRoom(
  root: string,
  {
    abi = null,
    variant = null,
    platform = process.platform,
    object = null,
  }: {
    abi?: string | null;
    variant?: string | null;
    platform?: NodeJS.Platform;
    object?: AndroidLongestObject | null;
  } = {},
): AndroidPathRoom | null {
  if (platform !== 'win32') return null;
  const { target, tail: objectTail } = object ?? longestAndroidObject(root);
  const abiName = abi ?? LONGEST_ANDROID_ABI;
  const configurationLength = /release$/i.test(variant ?? '') ? 'RelWithDebInfo'.length : 'Debug'.length;
  const tail = objectTail + configurationLength - 'Debug'.length + abiName.length;
  const longest = root.length + tail;
  if (longest <= LONGEST_SHORTENED_OBJECT_PATH) return null;
  return { root, abi: abiName, target, longest, maxRootLength: LONGEST_SHORTENED_OBJECT_PATH - tail };
}

export function androidPathRoomMessage({ root, abi, target, longest, maxRootLength }: AndroidPathRoom): string {
  return (
    `The project root ${root} is ${root.length} characters, so the longest known Android native object path ` +
    `(${target} for ${abi}) reaches ${longest} characters, past the ${LONGEST_SHORTENED_OBJECT_PATH} ` +
    `CMake can shorten it to for the NDK's ninja on Windows; the root can be at most ${maxRootLength} characters.`
  );
}

export function androidPathRoomRemedy({ maxRootLength }: AndroidPathRoom): string {
  return (
    `Move or clone the project to a real path of at most ${maxRootLength} characters, such as C:\\src\\<name>, ` +
    'and run Stim there. A subst drive does not help: Node and Expo autolinking resolve it back to the long path.'
  );
}

export function androidPathRoomRefusal(
  root: string,
  options: Parameters<typeof androidPathRoom>[1],
): { code: 'STIM_PATH_TOO_LONG'; reason: string; remedy: string } | null {
  const room = androidPathRoom(root, options);
  return room
    ? { code: 'STIM_PATH_TOO_LONG', reason: androidPathRoomMessage(room), remedy: androidPathRoomRemedy(room) }
    : null;
}
