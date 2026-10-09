import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../../packages/server/src/server.ts';
import { buildFrameHelper } from '../../../packages/server/src/frame-helper.ts';
import { createRequestLog } from '../../../packages/server/src/request-log.ts';

assert.equal(process.env.CI, '1');
assert.equal(process.platform, 'darwin');
assert(process.send, 'The CI driver must own this process.');
const root = process.env.STIM_HOSTED_XCODE_ROOT;
assert(root && process.env.STIM_HOME === join(root, 'host-home'));
const evidence = process.env.STIM_HOSTED_XCODE_EVIDENCE;
const abort = new AbortController();
let server;
let proxy;
let startup;
let closing;
const sockets = new Set();
function close() {
  abort.abort();
  closing ??= (async () => {
    await startup?.catch(() => {});
    try {
      if (proxy) {
        const stopped = new Promise((resolve) => proxy.close(resolve));
        for (const socket of sockets) socket.destroy();
        await stopped;
      }
    } finally {
      await server?.close();
      if (process.connected) process.disconnect();
    }
  })();
  return closing;
}
function requestClose() {
  void close().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
for (const signal of ['SIGINT', 'SIGTERM', 'disconnect']) process.on(signal, requestClose);
process.on('message', (message) => {
  if (message === 'close') requestClose();
});
if (!process.connected) abort.abort();
async function start() {
  abort.signal.throwIfAborted();
  const frameHelper =
    process.env.STIM_NATIVE_WORKER_ONLY === '1'
      ? null
      : await buildFrameHelper(
          process.env,
          abort.signal,
          fileURLToPath(new URL('../../../packages/server/dist/stim-frames/', import.meta.url)),
        );
  abort.signal.throwIfAborted();
  const requestLog = createRequestLog({
    debug: {
      enabled: () => true,
      log: (event, fields) =>
        appendFileSync(join(evidence, 'host-requests.ndjson'), JSON.stringify({ event, ...fields }) + '\n'),
    },
  });
  server = await startServer({
    name: 'CI native Xcode host',
    hosts: ['127.0.0.1'],
    port: 0,
    stimCli: fileURLToPath(new URL('../../../packages/stim-cli/dist/cli.mjs', import.meta.url)),
    stimVersion: 'ci',
    serverVersion: 'ci',
    env: process.env,
    tailscale: join(root, 'bin', 'tailscale'),
    tailscaleState: { state: 'not-running', backendState: 'Stopped' },
    record: false,
    history: false,
    frameHelper,
    requestLog,
  });
  abort.signal.throwIfAborted();
  assert.equal((await server.ready).state, 'ready');
  abort.signal.throwIfAborted();
  assert.equal(server.addresses.length, 1);
  const port = server.addresses[0].port;
  function headers(incoming) {
    return {
      ...Object.fromEntries(
        Object.entries(incoming).filter(([key]) => !key.startsWith('x-forwarded-') && key !== 'forwarded'),
      ),
      host: `127.0.0.1:${port}`,
      'x-forwarded-for': '100.64.0.11',
    };
  }
  proxy = createServer(
    {
      key: readFileSync(join(root, 'tls.key')),
      cert: readFileSync(join(root, 'tls.crt')),
    },
    (incoming, response) => {
      const upstream = request(
        {
          hostname: '127.0.0.1',
          port,
          path: incoming.url,
          method: incoming.method,
          headers: headers(incoming.headers),
        },
        (reply) => {
          response.writeHead(reply.statusCode, reply.headers);
          reply.pipe(response);
        },
      );
      upstream.on('error', () => {
        response.writeHead(502);
        response.end();
      });
      incoming.on('aborted', () => upstream.destroy());
      response.on('close', () => upstream.destroy());
      incoming.pipe(upstream);
    },
  );
  proxy.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  proxy.on('upgrade', (incoming, socket, head) => {
    const upstream = connect(port, '127.0.0.1', () => {
      upstream.write(
        `${incoming.method} ${incoming.url} HTTP/1.1\r\n${Object.entries(headers(incoming.headers))
          .map(([key, value]) => `${key}: ${value}`)
          .join('\r\n')}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  });
  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });
  abort.signal.throwIfAborted();
  process.send({ machine: `localhost:${proxy.address().port}` });
}
try {
  startup = start();
  await startup;
} catch (error) {
  if (!abort.signal.aborted) {
    console.error(error);
    process.exitCode = 1;
  }
  await close();
}
