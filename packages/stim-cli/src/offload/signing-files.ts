import { readFile, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { HOLDS_SIGNING_FILE } from '../build-placement.ts';

const KEYSTORE_FILE = /(?:\.(?:keystore|jks|p12|pfx)|(?:^|\/)keystore\.properties)$/i;
const VALUE_FILE = /(?:\.properties|(?:^|\/)credentials\.json)$/i;
const VALUE_ASSIGNMENT = /["']?([\w.-]+)["']?[ \t]*[=:][ \t]*["']?([^\s"',}]+)/g;
const KEY_PASSWORD_NAME = /^(?:(?:.*[._-])?(?:upload|release|signing|keystore)[._-])?key[._-]?pass(?:word)?$/i;
const STORE_PASSWORD_NAME = /^(?:.*[._-])?(?:key)?store[._-]?pass(?:word)?$/i;
const OTHER_STORE_NAME = /trust|javax|(?<![a-z0-9])app[._-]store/i;
const GRADLE_SCRIPT = /\.gradle(?:\.kts)?$/i;
const GRADLE_COMMENT = /\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$/gm;
const COMMENT_LINE = /^[ \t]*[#!].*$/gm;
const APPLE_SIGNING_FILE = /\.(?:p8|p12|mobileprovision|provisionprofile)$/;
const XCODE_BUILD_FILE = /(?:\.(?:pbxproj|xcconfig|podspec|sh)|(?:^|\/)Podfile)$/;
const APK_CONTENT = /(?:^|\/)src\/[^/]+\/(?:assets|res)\//;
const GRADLE_PASSWORD = /(?<!['"[])(?:store|key)Password\s*[=(]?\s*["']([^"'\n]+)["']/gi;
const NOT_A_PASSWORD = /^(?:android|null|\*+)$|^\$/;
const DEBUG_KEYSTORE = 'debug.keystore';

/**
 * A file an Android offload leaves out of the sync: a keystore other than the template's or one the APK carries as an
 * asset, or `keystore.properties`.
 */
export function isSigningKeystore(path: string): boolean {
  return KEYSTORE_FILE.test(path) && basename(path) !== DEBUG_KEYSTORE && !APK_CONTENT.test(path);
}

function isPassword(value: string | undefined): boolean {
  return value !== undefined && !NOT_A_PASSWORD.test(value);
}

function isSigningName(name: string | undefined): boolean {
  if (name === undefined) return false;
  return KEY_PASSWORD_NAME.test(name) || (STORE_PASSWORD_NAME.test(name) && !OTHER_STORE_NAME.test(name));
}

function setsSigningPassword(text: string): boolean {
  for (const [, name, value] of text.replace(COMMENT_LINE, '').matchAll(VALUE_ASSIGNMENT))
    if (isSigningName(name) && isPassword(value)) return true;
  return false;
}

function writesSigningPassword(text: string): boolean {
  for (const [, value] of text.replace(GRADLE_COMMENT, '').matchAll(GRADLE_PASSWORD))
    if (isPassword(value)) return true;
  return false;
}

/**
 * The first of `paths`, relative to `repoRoot`, that holds an Android signing secret `isSigningKeystore` cannot leave
 * out: a file named in `configured` under any name, a properties or credentials file that sets an Android signing
 * password by its usual names, or a Gradle script that writes one as a literal. Null when none does.
 */
async function firstSigningFile(
  repoRoot: string,
  paths: readonly string[],
  configured: readonly string[],
): Promise<string | null> {
  const realRoot = await realpath(repoRoot);
  const named = new Set(await Promise.all(configured.map((path) => realpath(path).catch(() => null))));
  for (const path of paths) {
    if (basename(path) === DEBUG_KEYSTORE) continue;
    if (named.has(join(realRoot, path))) return path;
    const holds = VALUE_FILE.test(path) ? setsSigningPassword : GRADLE_SCRIPT.test(path) ? writesSigningPassword : null;
    if (!holds) continue;
    let text: string;
    try {
      text = await readFile(join(realRoot, path), 'utf8');
    } catch {
      return path;
    }
    if (holds(text)) return path;
  }
  return null;
}

export interface SyncPlan {
  omit: ReadonlySet<string>;
  refusal: string | null;
}

/**
 * What an Android offload of `paths`, relative to `repoRoot`, leaves out or refuses. A release build gets no signing
 * file and refuses a secret it cannot leave out, because its worker builds unsigned. A debug build is never refused and
 * keeps a signing file that a Gradle script names, in `paths` or in `projectScripts`, since a script can need it to
 * configure at all. A name a script builds at run time, or one that only `gradle.properties` holds, is not seen.
 */
export async function androidSyncPlan(
  repoRoot: string,
  paths: readonly string[],
  {
    release,
    configured,
    projectScripts,
  }: { release: boolean; configured: readonly string[]; projectScripts: readonly string[] },
): Promise<SyncPlan> {
  const signing = paths.filter(isSigningKeystore);
  if (release) {
    const found = await firstSigningFile(repoRoot, paths, configured);
    return {
      omit: new Set(signing),
      refusal: found
        ? `${found} ${HOLDS_SIGNING_FILE}, and a release build never sends those to another machine`
        : null,
    };
  }
  if (signing.length === 0) return { omit: new Set(), refusal: null };
  const scripts = [
    ...paths.filter((path) => GRADLE_SCRIPT.test(path)).map((path) => join(repoRoot, path)),
    ...projectScripts,
  ];
  const texts = await Promise.all(scripts.map((script) => readFile(script, 'utf8').catch(() => '')));
  return {
    omit: new Set(signing.filter((path) => !texts.some((text) => text.includes(basename(path))))),
    refusal: null,
  };
}

/**
 * What an iOS offload of `paths`, relative to `repoRoot`, leaves out: an App Store Connect key, certificate or
 * provisioning profile that no Xcode project, xcconfig, Podfile, podspec or shell script names. A simulator build
 * signs ad hoc and reads none of them; a file one of those names stays, so the build finds it.
 */
// @ref LLP 0009#signing-stays-with-the-client -- ignored fingerprint inputs can contain signing secrets
export async function iosSyncPlan(repoRoot: string, paths: readonly string[]): Promise<SyncPlan> {
  const signing = paths.filter((path) => APPLE_SIGNING_FILE.test(path));
  if (signing.length === 0) return { omit: new Set(), refusal: null };
  const texts = await Promise.all(
    paths
      .filter((path) => XCODE_BUILD_FILE.test(path))
      .map((path) => readFile(join(repoRoot, path), 'utf8').catch(() => '')),
  );
  return {
    omit: new Set(signing.filter((path) => !texts.some((text) => text.includes(basename(path))))),
    refusal: null,
  };
}
