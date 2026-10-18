import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { sendToOwnedPage } from '../../web/page.ts';

const outcome = process.argv[2];
const http = createServer((_request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/owned` }));
});
const server = new WebSocketServer({ server: http, path: '/devtools/browser/owned' });
const controller = new AbortController();
const disconnected = new Promise<void>((resolve) => {
  server.on('connection', (socket) => {
    socket.once('close', resolve);
    socket.on('message', (raw) => {
      const { id, method }: { id: number; method: string } = JSON.parse(String(raw));
      if (method === 'Page.navigate') {
        if (outcome === 'cancelled') controller.abort();
        if (outcome === 'unacknowledged' || outcome === 'cancelled') return;
        socket.send(
          JSON.stringify(
            outcome === 'rejected' ? { id, error: { message: 'navigation refused' } } : { id, result: {} },
          ),
        );
        return;
      }
      const result =
        method === 'SystemInfo.getProcessInfo'
          ? { processInfo: [{ type: 'browser', id: 123 }] }
          : method === 'Target.attachToTarget'
            ? { sessionId: 'session' }
            : { targetInfo: { url: 'http://localhost/owned' } };
      socket.send(JSON.stringify({ id, result }));
    });
  });
});
http.listen(0, '127.0.0.1');
await once(http, 'listening');
const address = http.address();
assert(address && typeof address === 'object');
const port = address.port;
let result: unknown;
try {
  try {
    const url = await sendToOwnedPage(
      {
        pid: 122,
        processToken: 'supervisor',
        chromeProcess: { pid: 123, processToken: 'chrome' },
        cdpPort: port,
        targetId: 'PAGE',
        chrome: '/Chrome',
        profile: '/owned/profile',
        url: 'http://localhost/owned',
        startedAt: '',
        headless: true,
        viewport: 'desktop',
        ignoreCertificateErrors: false,
      },
      'Page.navigate',
      { url: 'http://localhost/next' },
      controller.signal,
    );
    result = { url };
  } catch (error) {
    assert(error instanceof Error);
    result = { message: error.message, ...('code' in error ? { code: error.code } : {}) };
  }
  await disconnected;
} finally {
  controller.abort();
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
}
await new Promise(setImmediate);
console.log(
  JSON.stringify({ result, timeouts: process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length }),
);
