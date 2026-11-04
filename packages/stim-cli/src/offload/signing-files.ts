import { readFile, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';

const KEYSTORE_FILE = /(?:\.(?:keystore|jks)|(?:^|\/)keystore\.properties)$/i;
const PASSWORD_HOLDER = /(?:\.properties|(?:^|\/)credentials\.json)$/i;
const SIGNING_PASSWORD = /(?:store|key)[._-]?pass(?:word)?["']?\s*[=:]\s*["']?([^\s"',]+)/gi;
const DEBUG_KEYSTORE = 'debug.keystore';
const DEBUG_PASSWORD = 'android';

/** A file an Android offload leaves out of the sync: a keystore other than the template's, or `keystore.properties`. */
export function isSigningKeystore(path: string): boolean {
  return KEYSTORE_FILE.test(path) && basename(path) !== DEBUG_KEYSTORE;
}

/**
 * The first of `paths`, relative to `repoRoot`, that holds an Android signing secret under a name `isSigningKeystore`
 * cannot leave out: `configuredKeystore` under any name, or a properties or credentials file that assigns a store or
 * key password other than the debug keystore's. Null when none does.
 */
export async function firstSigningFile(
  repoRoot: string,
  paths: readonly string[],
  configuredKeystore: string | null,
): Promise<string | null> {
  const realRoot = await realpath(repoRoot);
  const configured = configuredKeystore ? await realpath(configuredKeystore).catch(() => null) : null;
  for (const path of paths) {
    if (basename(path) === DEBUG_KEYSTORE) continue;
    if (join(realRoot, path) === configured) return path;
    if (!PASSWORD_HOLDER.test(path)) continue;
    let text: string;
    try {
      text = await readFile(join(realRoot, path), 'utf8');
    } catch {
      return path;
    }
    for (const match of text.matchAll(SIGNING_PASSWORD)) if (match[1] !== DEBUG_PASSWORD) return path;
  }
  return null;
}
