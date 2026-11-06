import { OFFLOAD_JOB_KINDS, type OffloadJobKind } from '@stim-cli/core/protocol';

/**
 * `stim __job <kind>`: the children stimd and offload jobs start from a build's own entry.
 * - `offload-build` and `offload-probe` serve one client's offload methods over stdin and stdout; stimd starts them
 *   with `STIM_JOB_SPEC`.
 * - `offload-worker <mode> [arg]` is the child an offload job starts for each build, offer probe and artifact query.
 * - `install <root> <build> release <version> | from <dir>` installs a client's build into the engine store and
 *   prints its build id.
 * Resolves the exit code.
 */
export async function runJobEntry(argv: readonly string[]): Promise<number> {
  const [kind, ...rest] = argv;
  if ((OFFLOAD_JOB_KINDS as readonly string[]).includes(kind ?? '')) {
    const { serveOffloadJob } = await import('./offload/serve.ts');
    const stop = new AbortController();
    process.once('SIGTERM', () => stop.abort());
    return serveOffloadJob(
      kind as OffloadJobKind,
      JSON.parse(process.env.STIM_JOB_SPEC ?? '{}'),
      process.stdin,
      process.stdout,
      stop.signal,
    );
  }
  if (kind === 'offload-worker') {
    const { runOffloadWorker } = await import('./offload/worker.ts');
    await runOffloadWorker(rest[0], rest[1]);
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  }
  if (kind === 'install' && rest.length === 4 && (rest[2] === 'release' || rest[2] === 'from')) {
    const [root, build, source, value] = rest as [string, string, string, string];
    const { installJobBuild } = await import('./install.ts');
    try {
      const installed = await installJobBuild(root, build, source === 'release' ? { release: value } : { from: value });
      process.stdout.write(`${JSON.stringify({ build: installed })}\n`);
      return 0;
    } catch (error) {
      const { message, mismatch } = error as Error & { mismatch?: boolean };
      process.stdout.write(`${JSON.stringify({ error: message.split('\n')[0], mismatch: mismatch === true })}\n`);
      return 1;
    }
  }
  process.stderr.write(
    'usage: stim __job offload-build | offload-probe | offload-worker <mode> | install <root> <build> release <version> | from <dir>\n',
  );
  return 2;
}
