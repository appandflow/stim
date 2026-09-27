import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Returns `<dir>/<name>-<hash>`, compiling it with `compile` first when it is missing. The hash covers `version` and
 * each input's name and bytes, so a changed source or compiler builds a new helper beside the old one. `compile`
 * writes to a private temporary path that is renamed into place, so concurrent builders never expose a partial file.
 */
export async function compiledHelper({
  dir,
  name,
  inputs,
  version,
  compile,
}: {
  dir: string;
  name: string;
  inputs: readonly string[];
  version: string;
  compile: (output: string) => Promise<void>;
}): Promise<string> {
  const hash = createHash('sha256').update(version);
  for (const input of inputs) hash.update(basename(input)).update(readFileSync(input));
  const helper = join(dir, `${name}-${hash.digest('hex').slice(0, 16)}`);
  if (existsSync(helper)) return helper;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const output = `${helper}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await compile(output);
    renameSync(output, helper);
  } finally {
    rmSync(output, { force: true });
  }
  return helper;
}
