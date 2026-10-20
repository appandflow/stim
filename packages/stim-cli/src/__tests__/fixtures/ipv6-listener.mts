import assert from 'node:assert/strict';
import { createServer } from 'node:net';

const server = createServer((socket) => socket.destroy());
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EAFNOSUPPORT' && error.code !== 'EADDRNOTAVAIL') throw error;
  assert(process.send);
  process.send(null);
  process.disconnect();
});
server.listen({ port: 0, host: '::1', ipv6Only: true }, () => {
  const address = server.address();
  assert(address && typeof address === 'object' && process.send);
  process.send(address.port);
});
