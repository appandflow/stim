import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { MainContext } from '../../bin/cli.ts';

const ANSWER_MS = 5000;
const FRESH_ANSWER_MS = 30_000;

/** This dist's build id, as `stimBuildId` computes it: the first 12 hex of the sha256 over its `*.mjs` names and bytes. */
function buildId(dir: string): string {
  const hash = createHash('sha256');
  for (const name of readdirSync(dir)
    .filter((entry) => entry.endsWith('.mjs'))
    .toSorted()) {
    hash.update(name);
    hash.update(readFileSync(join(dir, name)));
  }
  return hash.digest('hex').slice(0, 12);
}

/** stimd's answer to `status`, or null when no stimd of this build answers in time. */
function askStimd(fresh: boolean): Promise<Record<string, unknown> | null> {
  const configured = process.env.STIM_HOME;
  if (configured && !isAbsolute(configured)) return Promise.resolve(null);
  let socketPath: unknown;
  let build: string;
  try {
    socketPath = JSON.parse(
      readFileSync(join(configured || join(homedir(), '.stim'), 'run', 'stimd.json'), 'utf8'),
    ).socket;
    build = buildId(dirname(fileURLToPath(import.meta.url)));
  } catch {
    return Promise.resolve(null);
  }
  if (typeof socketPath !== 'string') return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const lines: Record<string, unknown>[] = [];
    let buffer = '';
    const end = (answer: Record<string, unknown> | null) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(fresh ? FRESH_ANSWER_MS : ANSWER_MS, () => end(null));
    socket.on('error', () => end(null));
    socket.on('close', () => end(null));
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        try {
          lines.push(JSON.parse(buffer.slice(0, at)));
        } catch {
          return end(null);
        }
        buffer = buffer.slice(at + 1);
        const [hello, answer] = lines;
        if (hello?.op !== 'hello') return end(null);
        if (answer) return end(answer.op === 'status' && !('error' in answer) ? answer : null);
      }
    });
    socket.once('connect', () =>
      socket.write(
        `${JSON.stringify({ kind: 'cli', build })}\n${JSON.stringify({ op: 'status', params: { cwd: process.cwd(), fresh } })}\n`,
      ),
    );
  });
}

/**
 * Runs `stim status` for `argv`, in `process.argv`'s shape. With `--json` (and without `--watch`) it prints the home's
 * stimd's last status snapshot with its `ageMs`, or `{ageMs: null, booting: true}` while stimd has none yet; `--fresh`
 * makes stimd read the state first. Without a stimd of this build, and for every other form, it runs the `status`
 * command of the CLI.
 */
export async function main(argv: string[], ctx: MainContext = {}): Promise<void> {
  let values: { json?: boolean; watch?: boolean; fresh?: boolean } = {};
  try {
    ({ values } = parseArgs({
      args: argv.slice(3),
      options: { json: { type: 'boolean' }, watch: { type: 'boolean' }, fresh: { type: 'boolean' } },
    }));
  } catch {}
  const answer = values.json && !values.watch ? await askStimd(values.fresh === true) : null;
  if (answer) {
    const { status, ageMs, booting } = answer;
    process.stdout.write(
      `${JSON.stringify(booting ? { ageMs: null, booting: true } : { ...(typeof status === 'object' ? status : {}), ageMs })}\n`,
    );
    return;
  }
  Reflect.set(globalThis, Symbol.for('stim.main'), true);
  let cli: typeof import('../../bin/node-check.ts');
  try {
    cli = await import('../../bin/node-check.ts');
  } catch (error) {
    if (!ctx.onLoadError) throw error;
    await ctx.onLoadError(error);
    return;
  }
  await cli.main(argv, ctx);
}

if (!Reflect.get(globalThis, Symbol.for('stim.main'))) void main(process.argv);
