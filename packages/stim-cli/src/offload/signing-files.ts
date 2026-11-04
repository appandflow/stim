import { readFile, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';

const KEYSTORE_FILE = /(?:\.(?:keystore|jks|p12|pfx)|(?:^|\/)keystore\.properties)$/i;
const VALUE_FILE = /(?:\.properties|(?:^|\/)credentials\.json|(?:^|\/)\.env[^/]*)$/i;
const VALUE_PASSWORD = /(?:store|key)[._-]?pass(?:word)?["']?\s*[=:]\s*["']?([^\s"',]+)/gi;
const GRADLE_FILE = /\.gradle(?:\.kts)?$/i;
const GRADLE_PASSWORD = /(?:store|key)Password\s*[=(]?\s*["']([^"']+)["']/gi;
const DEBUG_KEYSTORE = 'debug.keystore';
const DEBUG_PASSWORD = 'android';

/** A file an Android offload leaves out of the sync: a keystore other than the template's, or `keystore.properties`. */
export function isSigningKeystore(path: string): boolean {
  return KEYSTORE_FILE.test(path) && basename(path) !== DEBUG_KEYSTORE;
}

function literalPassword(text: string, pattern: RegExp): boolean {
  for (const match of text.matchAll(pattern)) {
    const value = match[1]!;
    if (value !== DEBUG_PASSWORD && !value.includes('$')) return true;
  }
  return false;
}

/**
 * The first of `paths`, relative to `repoRoot`, that holds an Android signing secret `isSigningKeystore` cannot leave
 * out: a file named in `configured` under any name, a properties, credentials or `.env` file that assigns a store or
 * key password other than the debug keystore's, or a Gradle script that writes one as a literal. Null when none does.
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
    const pattern = VALUE_FILE.test(path) ? VALUE_PASSWORD : GRADLE_FILE.test(path) ? GRADLE_PASSWORD : null;
    if (!pattern) continue;
    let text: string;
    try {
      text = await readFile(join(realRoot, path), 'utf8');
    } catch {
      return path;
    }
    if (literalPassword(text, pattern)) return path;
  }
  return null;
}
