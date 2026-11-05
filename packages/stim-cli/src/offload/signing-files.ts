import { readFile, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';

const KEYSTORE_FILE = /(?:\.(?:keystore|jks|p12|pfx)|(?:^|\/)keystore\.properties)$/i;
const VALUE_FILE =
  /(?:\.properties|(?:^|\/)credentials\.json|(?:^|\/)\.env(?![^/]*(?:example|sample|template))[^/]*)$/i;
const VALUE_ASSIGNMENT = /["']?([\w.-]+)["']?[ \t]*[=:][ \t]*["']?([^\s"',}]+)/g;
const KEY_PASSWORD_NAME = /^(?:(?:.*[._-])?(?:upload|release|signing|keystore)[._-])?key[._-]?pass(?:word)?$/i;
const STORE_PASSWORD_NAME = /^(?:.*[._-])?(?:key)?store[._-]?pass(?:word)?$/i;
const OTHER_STORE_NAME = /trust|javax|(?<![a-z0-9])app[._-]store/i;
const COMMENT_LINE = /^[ \t]*[#!].*$/gm;
const APK_CONTENT = /(?:^|\/)src\/[^/]+\/(?:assets|res)\//;
const GRADLE_FILE = /\.gradle(?:\.kts)?$/i;
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
  for (const [, value] of text.replace(COMMENT_LINE, '').matchAll(GRADLE_PASSWORD)) if (isPassword(value)) return true;
  return false;
}

/**
 * The first of `paths`, relative to `repoRoot`, that holds an Android signing secret `isSigningKeystore` cannot leave
 * out: a file named in `configured` under any name, a properties, credentials or `.env` file that sets an Android
 * signing password by its usual names, or a Gradle script that writes one as a literal. Null when none does.
 */
export async function firstSigningFile(
  repoRoot: string,
  paths: readonly string[],
  configured: readonly string[],
): Promise<string | null> {
  const realRoot = await realpath(repoRoot);
  const named = new Set(await Promise.all(configured.map((path) => realpath(path).catch(() => null))));
  for (const path of paths) {
    if (basename(path) === DEBUG_KEYSTORE) continue;
    if (named.has(join(realRoot, path))) return path;
    const holds = VALUE_FILE.test(path) ? setsSigningPassword : GRADLE_FILE.test(path) ? writesSigningPassword : null;
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
