import assert from 'node:assert';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { withAmbientContext } from '@stim-cli/core';
import { resolveWorkspaceMetroPort, startDevServer } from '../commands/start.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { captureProcessToken } from '../process-identity.ts';
import { getProject, upsertProject } from '../workspace/config.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { testContext } from './_context.ts';

let home: string;
let root: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-start-context-')));
  root = join(home, 'app');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.88.0' } }));
  vi.stubEnv('STIM_HOME', home);
});
afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test('pinned startup port lookup leaves the event loop responsive while its native probe is pending', async () => {
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileQuiet: () => {
      throw new Error('blocking startup probe');
    },
    runFileQuietAsync: () =>
      real.runFileAsync(process.execPath, ['-e', 'setTimeout(() => {}, 150)'], { timeoutMs: 2000 }),
  });
  let settled = false;
  const pending = resolveWorkspaceMetroPort(root, { metro: { port: 23456 } }, () => {}, 'start', false);
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  try {
    await delay(20);
    expect(settled).toBe(false);
    await expect(pending).resolves.toBe(23456);
    expect(getProject(root)).toBeNull();
  } finally {
    await pending.catch(() => {});
  }
});

test('cancelling a startup HTTP status probe refuses before reserving the pinned port', async () => {
  let requested!: () => void;
  const probing = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const server = createServer(() => requested());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const real = getExecutor();
  setExecutor({ ...real, runFileQuiet: () => String(process.pid), runFileQuietAsync: async () => String(process.pid) });
  const controller = new AbortController();
  const pending = withAmbientContext(
    testContext({ home, projectRoot: root, cwd: root, signal: controller.signal }),
    () => resolveWorkspaceMetroPort(root, { metro: { port: address.port } }, () => {}, 'start', false),
  );
  const completed = pending.catch((cause: unknown) => cause);
  try {
    await probing;
    controller.abort();
    expect(await Promise.race([completed, delay(200, 'pending')])).toMatchObject({ code: 'STIM_CANCELLED' });
    expect(getProject(root)).toBeNull();
  } finally {
    controller.abort();
    server.closeAllConnections();
    await completed;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('cancelling readiness sleep keeps the existing supervisor and starts no replacement', async () => {
  const port = 23456;
  upsertProject(root, { metroPort: port });
  const supervisor = {
    pid: process.pid,
    processToken: captureProcessToken(process.pid),
    port,
    mode: 'bare-inproc',
    startedAt: new Date().toISOString(),
  };
  assert(supervisor.processToken);
  writeWorkspaceState(root, { supervisor });
  let probes = 0;
  let reading!: () => void;
  const ready = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const inspect = () => {
    if (++probes === 2) reading();
    return '';
  };
  const spawn = vi.fn<ReturnType<typeof getExecutor>['spawn']>(() => {
    throw new Error('replacement supervisor');
  });
  setExecutor({ ...getExecutor(), runFileQuiet: inspect, runFileQuietAsync: async () => inspect(), spawn });
  const controller = new AbortController();
  const pending = withAmbientContext(
    testContext({ home, projectRoot: root, cwd: root, signal: controller.signal }),
    () =>
      startDevServer({
        root,
        settings: {},
        settingsContext: { projectPath: root, gitCommonDir: null, repoRoot: root },
        waitSeconds: 1,
        out: () => {},
        note: () => {},
      }),
  );
  const completed = pending.catch((cause: unknown) => cause);
  try {
    await ready;
    await nextTurn();
    controller.abort();
    expect(await Promise.race([completed, delay(200, 'pending')])).toMatchObject({ code: 'STIM_CANCELLED' });
    expect(spawn).not.toHaveBeenCalled();
    expect(readWorkspaceState(root)?.supervisor).toEqual(supervisor);
  } finally {
    controller.abort();
    await completed;
  }
});
