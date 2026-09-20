/**
 * The NDK's ninja is not long-path aware, so every object path it opens has to stay under Windows'
 * MAX_PATH. CMake names the object for a source outside its source directory after that source's
 * mangled absolute path, so a React Native codegen object carries the project root twice unless
 * CMake shortens it, and CMake shortens (hashes the leading directories of) an object name only
 * while the result stays under CMAKE_OBJECT_PATH_MAX; past that it keeps the full name, which
 * ninja then cannot create. `shim/android-optimizations.gradle` sets that maximum on Windows.
 * https://github.com/appandflow/stim/issues/893
 */
export const ANDROID_OBJECT_PATH_MAX = 240;

/**
 * Characters the longest known shortened object path adds to the project root and the ABI name,
 * measured on the bare e2e fixture at a 36-character root:
 * `\android\app\.cxx\stim-<16 hex>\Debug\<8 chars>\<abi>\safeareacontext_autolinked_build/CMakeFiles/react_codegen_safeareacontext.dir/<md5>/RNCSafeAreaViewShadowNode.cpp.o`.
 * At that root the path reaches ANDROID_OBJECT_PATH_MAX and CMake leaves it unshortened (341
 * characters); the same fixture builds at a 33-character root.
 */
export const LONGEST_ANDROID_OBJECT_PATH_TAIL = 198;

/** The ABI name a build for every ABI has to fit; `stim android` narrows a build to the device's. */
const LONGEST_ANDROID_ABI = 'armeabi-v7a';

export interface AndroidPathRoom {
  root: string;
  abi: string;
  longest: number;
  maxRootLength: number;
}

export function androidPathRoom(
  root: string,
  { abi = null, platform = process.platform }: { abi?: string | null; platform?: NodeJS.Platform } = {},
): AndroidPathRoom | null {
  if (platform !== 'win32') return null;
  const abiName = abi ?? LONGEST_ANDROID_ABI;
  const tail = LONGEST_ANDROID_OBJECT_PATH_TAIL + abiName.length;
  const longest = root.length + tail;
  if (longest < ANDROID_OBJECT_PATH_MAX) return null;
  return { root, abi: abiName, longest, maxRootLength: ANDROID_OBJECT_PATH_MAX - 1 - tail };
}

export function androidPathRoomMessage({ root, abi, longest, maxRootLength }: AndroidPathRoom): string {
  return (
    `The project root ${root} is ${root.length} characters, so the longest known Android native object path ` +
    `(react_codegen_safeareacontext for ${abi}) reaches ${longest} characters, past the ${ANDROID_OBJECT_PATH_MAX - 1} ` +
    `the NDK's ninja can be given on Windows; the root can be at most ${maxRootLength} characters.`
  );
}

export function androidPathRoomRemedy({ root }: AndroidPathRoom): string {
  return `Map the project to a drive letter (\`subst X: ${root}\`) and run Stim from X:\\, or move it under a shorter root.`;
}
