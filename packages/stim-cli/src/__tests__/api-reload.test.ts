import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { workspaceName } from '@stim-cli/core';
import { captureProcessToken } from '../process-identity.ts';
import { createStim, StimError } from '../api.ts';

let scratch: string;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-api-reload-')));
  vi.stubEnv('STIM_HOME', join(scratch, 'caller-home'));
});

afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

async function browserFixture(name: string, holdAttach = false) {
  const root = join(scratch, name);
  const home = join(scratch, `${name}-home`);
  const area = join(home, 'workspaces', workspaceName(root));
  mkdirSync(root);
  mkdirSync(area, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.83.0' } }));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ projects: { [root]: { metroPort: null } } }));
  const url = `http://localhost/${name}`;
  const http = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/owned` }));
  });
  const server = new WebSocketServer({ server: http, path: '/devtools/browser/owned' });
  const methods: string[] = [];
  let attached!: () => void;
  const attaching = new Promise<void>((resolve) => {
    attached = resolve;
  });
  server.on('connection', (socket) =>
    socket.on('message', (raw) => {
      const { id, method }: { id: number; method: string } = JSON.parse(String(raw));
      methods.push(method);
      if (method === 'Target.attachToTarget' && holdAttach) {
        attached();
        return;
      }
      const result =
        method === 'SystemInfo.getProcessInfo'
          ? { processInfo: [{ type: 'browser', id: process.pid }] }
          : method === 'Target.getTargetInfo'
            ? { targetInfo: { url } }
            : method === 'Target.attachToTarget'
              ? { sessionId: 'page-session' }
              : {};
      socket.send(JSON.stringify({ id, result }));
    }),
  );
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  const processToken = captureProcessToken(process.pid);
  assert(processToken);
  writeFileSync(
    join(area, 'state.json'),
    JSON.stringify({
      web: {
        pid: process.pid,
        processToken,
        chromeProcess: { pid: process.pid, processToken },
        cdpPort: port,
        targetId: 'PAGE',
        profile: join(area, 'web', 'profile'),
        chrome: '/fixture/Chrome',
        url,
        startedAt: '',
        headless: true,
        viewport: 'desktop',
        ignoreCertificateErrors: false,
      },
    }),
  );
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return { root, home, area, url, methods, attaching, server };
}

test('concurrent reload clients use only their own home and leave the caller context unchanged', async () => {
  const first = await browserFixture('first');
  const second = await browserFixture('second');
  const environment = { ...process.env };
  const cwd = process.cwd();
  const interrupts = process.listeners('SIGINT');
  const log = vi.spyOn(console, 'log');
  const error = vi.spyOn(console, 'error');
  try {
    const results = await Promise.all(
      [first, second].map(({ root, home }) => createStim({ projectRoot: root, home }).reload({ platform: 'web' })),
    );
    expect(results.map((result) => result.appId)).toEqual([first.url, second.url]);
    for (const item of [first, second]) {
      expect(item.methods.filter((method) => method === 'Page.reload')).toEqual(['Page.reload']);
      expect(JSON.parse(readFileSync(join(item.area, 'state.json'), 'utf8')).lastUsedAt).toEqual(expect.any(String));
    }
    expect(process.cwd()).toBe(cwd);
    expect(process.env).toEqual(environment);
    expect(process.listeners('SIGINT')).toEqual(interrupts);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test('reload admission runs once on the resolved workspace before usage or dispatch', async () => {
  const item = await browserFixture('refused');
  const resolved: string[] = [];
  const client = createStim({ projectRoot: item.root, home: item.home });
  await expect(
    client.reload({
      beforeReload: (root) => {
        resolved.push(root);
        throw new StimError({ code: 'STIM_ACTION_BUSY', message: 'busy' });
      },
    }),
  ).rejects.toMatchObject({ code: 'STIM_ACTION_BUSY' });
  expect(resolved).toEqual([item.root]);
  expect(item.methods).toEqual([]);
  expect(JSON.parse(readFileSync(join(item.area, 'state.json'), 'utf8')).lastUsedAt).toBeUndefined();
});

test('API cancellation drains a pending browser attachment without sending a reload', async () => {
  const item = await browserFixture('cancelled', true);
  const controller = new AbortController();
  const pending = createStim({ projectRoot: item.root, home: item.home }).reload({
    platform: 'web',
    signal: controller.signal,
  });
  await item.attaching;
  const [socket] = item.server.clients;
  assert(socket);
  const closed = once(socket, 'close');
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
  await closed;
  expect(item.methods).not.toContain('Page.reload');
});
