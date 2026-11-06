import { renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { installServer } from '@stim-cli/server/release-install';
import { fetchTree, scratchName, seal, selfTest } from '../engine-store/tree.ts';

/** Where an offload job's build comes from: an npm release, or a directory holding the client's packed `.tgz`. */
export type JobSource = { release: string } | { from: string };

/**
 * Installs a client's build into the engine store at `root` for offload jobs, without making it this machine's
 * engine, and returns its build id once the tree passed its self-test. Throws when the installed build is not `build`.
 */
export async function installJobBuild(root: string, build: string, source: JobSource): Promise<string> {
  const scratch = join(root, scratchName());
  const log = (line: string) => console.error(line);
  try {
    if ('release' in source) {
      try {
        await fetchTree(root, { release: source.release }, scratch, log);
      } catch (error) {
        const unpublished = /E404|ETARGET|No matching version/.test(String((error as Error).message));
        throw Object.assign(error as Error, { mismatch: unpublished });
      }
    }
    else {
      const installs = join(root, scratchName());
      try {
        const options = ['--cache', join(root, '.npm-cache'), '--prefer-offline', '--install-strategy=shallow'];
        const { dir } = await installServer(join(installs, 'versions'), source, process.execPath, log, options);
        renameSync(join(dir, 'node_modules', 'stim'), scratch);
      } finally {
        rmSync(installs, { recursive: true, force: true });
      }
    }
    const sealed = seal(root, scratch);
    if (sealed !== build)
      throw Object.assign(
        new Error(`${'release' in source ? `stim@${source.release}` : 'the package'} is build ${sealed}, not ${build}`),
        { mismatch: true },
      );
    await selfTest(root, sealed);
    return sealed;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
