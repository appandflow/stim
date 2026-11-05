import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { sendToOwnedPage } from '../web/page.ts';

test('cancelling while Chrome attaches to the owned page prevents a late Page.reload', async () => {
  const http = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/owned` }));
  });
  const server = new WebSocketServer({ server: http, path: '/devtools/browser/owned' });
  const messages: string[] = [];
  let received!: () => void;
  let attachId: number | undefined;
  const attaching = new Promise<void>((resolve) => {
    received = resolve;
  });
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const { id, method }: { id: number; method: string } = JSON.parse(String(raw));
      messages.push(method);
      if (method === 'Target.attachToTarget') {
        attachId = id;
        received();
      } else {
        socket.send(
          JSON.stringify({
            id,
            result:
              method === 'SystemInfo.getProcessInfo'
                ? { processInfo: [{ type: 'browser', id: 123 }] }
                : { targetInfo: { url: 'http://localhost/owned' } },
          }),
        );
      }
    });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  const controller = new AbortController();
  try {
    const pending = sendToOwnedPage(
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
      'Page.reload',
      {},
      controller.signal,
    );
    await attaching;
    const [socket] = server.clients;
    assert(socket);
    const closed = once(socket, 'close');
    controller.abort();
    socket.send(JSON.stringify({ id: attachId, result: { sessionId: 'session' } }));
    await expect(pending).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
    await closed;
    expect(messages).toEqual(['SystemInfo.getProcessInfo', 'Target.getTargetInfo', 'Target.attachToTarget']);
  } finally {
    controller.abort();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
