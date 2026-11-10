import { createServer } from 'node:net';

export async function detachedHelper(pidFile: string): Promise<{ script: string; close: () => Promise<void> }> {
  const server = createServer();
  let closing = false;
  server.on('connection', (socket) => {
    if (closing) socket.end();
    else server.once('close-helper', () => socket.end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing helper listener address');
  const script = `
    const net = require('node:net');
    const fs = require('node:fs');
    const socket = net.connect(${address.port}, '127.0.0.1');
    socket.on('connect', () => fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)));
    socket.on('end', () => process.exit(0));
    socket.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 10000);
  `;
  return {
    script,
    async close() {
      closing = true;
      server.emit('close-helper');
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
