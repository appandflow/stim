import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { npmEnv } from '../engine-store/npm.ts';
import { getExecutor, resetExecutor } from '../exec.ts';

describe.skipIf(process.platform === 'win32')('npm lookup for engine updates', () => {
  const realExecPath = process.execPath;
  const realPath = process.env.PATH;
  let dir: string;

  beforeEach(() => {
    resetExecutor();
    dir = mkdtempSync(join(tmpdir(), 'stim-npm-path-'));
  });

  afterEach(() => {
    Object.defineProperty(process, 'execPath', { value: realExecPath, configurable: true });
    process.env.PATH = realPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds the npm that sits next to the running node when the service PATH lacks it', async () => {
    writeFileSync(join(dir, 'npm'), '#!/bin/sh\necho 9.9.9\n');
    chmodSync(join(dir, 'npm'), 0o755);
    Object.defineProperty(process, 'execPath', { value: join(dir, 'node'), configurable: true });
    process.env.PATH = '/usr/bin:/bin';

    await expect(
      getExecutor().runFileAsync('npm', ['--version'], { timeoutMs: 30_000, env: npmEnv(process.env) }),
    ).resolves.toBe('9.9.9');
  });

  it('falls back to the ambient PATH when no npm sits next to node', async () => {
    const bin = join(dir, 'bin');
    writeFileSync(join(dir, 'npm'), '#!/bin/sh\necho 8.8.8\n');
    chmodSync(join(dir, 'npm'), 0o755);
    Object.defineProperty(process, 'execPath', { value: join(dir, 'empty', 'node'), configurable: true });
    process.env.PATH = `${dirname(bin)}:/usr/bin:/bin`;

    await expect(
      getExecutor().runFileAsync('npm', ['--version'], { timeoutMs: 30_000, env: npmEnv(process.env) }),
    ).resolves.toBe('8.8.8');
  });

  it('runs the real npm found beside this node, or on the ambient PATH when the node has none', async () => {
    const besideNode = existsSync(join(dirname(realExecPath), 'npm'));
    process.env.PATH = besideNode ? '/usr/bin:/bin' : realPath;
    const out = await getExecutor().runFileAsync('npm', ['--version'], { timeoutMs: 30_000, env: npmEnv(process.env) });
    expect(out).toMatch(/^\d+\.\d+\.\d+/);
  });
});
