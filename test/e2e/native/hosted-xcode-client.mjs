import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { pinnedEndpoint } from '../../../packages/stim-cli/src/offload/tailnet.ts';

const { WebSocket } = createRequire(new URL('../../../packages/server/package.json', import.meta.url))('ws');

export async function openObserver(credential) {
  const target = pinnedEndpoint(credential);
  assert.notEqual(typeof target, 'string', 'The current Tailnet peer must match the stored host pin.');
  const socket = new WebSocket(target.url, {
    servername: target.servername,
    headers: { Host: target.host },
    handshakeTimeout: 10_000,
  });
  const replies = new Map();
  const frames = [];
  let nextId = 1;
  let failure;
  socket.on('error', (error) => {
    failure = error;
  });
  socket.on('close', () => {
    failure ??= new Error('Observer connection closed.');
  });
  socket.on('message', (bytes, binary) => {
    if (binary) return;
    const message = JSON.parse(String(bytes));
    if (message.event === 'frame') {
      frames.push(message);
      if (frames.length > 2) frames.shift();
    } else if (message.event === 'error') failure = new Error(message.error.message);
    else if (message.id !== undefined) replies.set(message.id, message);
  });
  async function until(read, timeout) {
    const deadline = Date.now() + timeout;
    do {
      const value = read();
      if (value) return value;
      if (failure) throw failure;
      await sleep(25);
    } while (Date.now() < deadline);
    throw new Error('Hosted observer did not receive the required evidence in time.');
  }
  await until(() => socket.readyState === WebSocket.OPEN, 10_000);
  const rpc = async (method, params) => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    const reply = await until(() => replies.get(id), 30_000);
    replies.delete(id);
    assert(!reply.error, `${method}: ${reply.error?.code}: ${reply.error?.message}`);
    return reply.result;
  };
  try {
    const hello = await rpc('hello', {
      protocol: 1,
      client: { name: 'CI hosted observer', version: '1' },
      auth: { deviceToken: credential.deviceToken },
    });
    assert.deepEqual(hello.capabilities, ['device-host']);
    assert(hello.features.includes('hosted-ios-process'));
  } catch (error) {
    socket.terminate();
    throw error;
  }
  return {
    rpc,
    frame: (subscription, since) =>
      until(
        () => frames.find((frame) => frame.subscription === subscription && Date.parse(frame.capturedAt) >= since),
        30_000,
      ),
    drop: () => socket.terminate(),
    close: () => socket.close(1000),
  };
}
