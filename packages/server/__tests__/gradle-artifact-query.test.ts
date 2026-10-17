import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { captureProcessIdentity, inspectProcessIdentity } from '@stim-cli/core/process-identity';
import { runArtifactQuery } from '../src/artifact-query.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stim-artifact-query-'));
  vi.stubEnv('STIM_HOME', join(root, 'home'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('The controlled query did not reach its gate.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test.each(['complete', 'cancel', 'deadline', 'output'])(
  'a %s query holds its area and drains its owned process group before releasing it',
  async (mode) => {
    const area = join(root, 'area');
    await mkdir(area);
    const worker = join(root, 'worker.mjs');
    await writeFile(
      worker,
      `
import { spawn } from 'node:child_process';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
process.on('SIGTERM', () => {});
let input = '';
for await (const chunk of process.stdin) input += chunk;
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
writeFileSync(join(process.cwd(), 'pids.partial'), JSON.stringify([process.pid, child.pid]));
renameSync(join(process.cwd(), 'pids.partial'), join(process.cwd(), 'pids.json'));
let emitted = false;
const timer = setInterval(() => {
  if (process.env.QUERY_MODE === 'output' && !emitted && existsSync(join(process.cwd(), 'go'))) {
    emitted = true;
    process.stdout.write('x'.repeat(32768));
  }
  if (!existsSync(join(process.cwd(), 'finish'))) return;
  clearInterval(timer);
  child.kill('SIGKILL');
  child.once('close', () => {
    console.log(JSON.stringify({ identity: { hash: 'a'.repeat(64), key: 'worker-key' } }));
  });
}, 10);
`,
    );
    const abort = new AbortController();
    const query = runArtifactQuery({
      worker,
      area,
      env: { ...process.env, QUERY_MODE: mode },
      query: {
        project: '',
        sourceDigest: 'b'.repeat(64),
        inputs: { complete: true, ignored: [], outputs: [] },
        android: { variant: 'debug', abi: null, compilerCache: 'none', pch: 'auto', gradleBuildCache: true },
      },
      receipt: {},
      signal: abort.signal,
      timeoutMs: mode === 'deadline' ? 1000 : 5000,
      killGraceMs: 50,
    });
    try {
      await until(() => existsSync(join(area, 'pids.json')));
      const pids: number[] = JSON.parse(readFileSync(join(area, 'pids.json'), 'utf8'));
      const records = pids.map((pid) => {
        const captured = captureProcessIdentity(pid);
        if (!captured.ok) throw new Error(captured.reason);
        return { pid, processToken: captured.token };
      });
      const held = readClaimSet(`${area}.claims`).live;
      expect(held).toHaveLength(1);
      expect(held[0]?.child?.pid).toBe(records[0]?.pid);
      const exclusive = tryAcquireClaim({ root: `${area}.claims`, mode: 'exclusive' });
      expect(exclusive.acquired).toBeUndefined();
      if (exclusive.pending) releaseClaim(exclusive.pending);
      if (mode === 'cancel') abort.abort();
      if (mode === 'complete') await writeFile(join(area, 'finish'), '');
      if (mode === 'output') await writeFile(join(area, 'go'), '');
      const result = await query.done;
      expect(result.settled).toBe(true);
      expect(result.identity !== null).toBe(mode === 'complete');
      expect(records.map(inspectProcessIdentity)).toEqual(['gone', 'gone']);
      expect(readClaimSet(`${area}.claims`).live).toEqual([]);
      const free = tryAcquireClaim({ root: `${area}.claims`, mode: 'exclusive' });
      expect(free.acquired).toBeDefined();
      if (free.acquired) releaseClaim(free.acquired);
    } finally {
      query.cancel();
      await query.done;
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'cancelling the real SwiftPM query drains its executor probe before freeing the area',
  async () => {
    const area = join(root, 'area');
    const tools = join(root, 'tools');
    await mkdir(area);
    await mkdir(tools);
    const marker = join(area, 'probe-pid');
    const swift = join(tools, 'swift');
    await writeFile(
      swift,
      `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
process.on('SIGTERM', () => {});
writeFileSync(process.env.STIM_QUERY_PROBE_PID, String(process.pid));
setInterval(() => {}, 1000);
`,
    );
    await chmod(swift, 0o755);
    const abort = new AbortController();
    const query = runArtifactQuery({
      worker: fileURLToPath(new URL('../../stim-cli/dist/offload-worker.mjs', import.meta.url)),
      area,
      env: { ...process.env, PATH: `${tools}:${process.env.PATH ?? ''}`, STIM_QUERY_PROBE_PID: marker },
      query: {
        project: '',
        sourceDigest: 'b'.repeat(64),
        stimBuild: 'b1',
        inputs: { complete: true, ignored: [], outputs: [], localFiles: [], environment: [] },
        build: { product: 'App', infoPlist: 'Info.plist', resources: {}, assetCatalog: null },
      },
      receipt: {},
      signal: abort.signal,
      timeoutMs: 5000,
      killGraceMs: 50,
    });
    let probe: { pid: number; processToken: string } | undefined;
    try {
      await until(() => existsSync(marker));
      const pid = Number(readFileSync(marker, 'utf8'));
      const captured = captureProcessIdentity(pid);
      if (!captured.ok) throw new Error(captured.reason);
      probe = { pid, processToken: captured.token };
      expect(readClaimSet(`${area}.claims`).live).toHaveLength(1);
      abort.abort();
      expect(await query.done).toEqual({ identity: null, settled: true });
      expect(inspectProcessIdentity(probe)).toBe('gone');
      expect(readClaimSet(`${area}.claims`).live).toEqual([]);
    } finally {
      query.cancel();
      await query.done;
      const retained = probe;
      if (retained && inspectProcessIdentity(retained) === 'same') {
        process.kill(retained.pid, 'SIGKILL');
        await until(() => inspectProcessIdentity(retained) === 'gone');
      }
    }
  },
);
