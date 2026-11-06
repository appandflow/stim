import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { dirname } from 'node:path';
import { WebSocketServer } from 'ws';
import type { WebShareRow } from '@stim-cli/core/protocol';
import { stimdClaimRoot, stimdRunDir, stimdSocket } from '@stim-cli/core/state';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';

export type ShareListAnswer =
  | { shares: WebShareRow[]; starting?: number }
  | { error: { code: string; message: string } };

export function shareRow(workspace: string, expiresAt: string, overrides: Partial<WebShareRow> = {}): WebShareRow {
  return {
    id: 'share-1',
    workspace,
    platform: 'ios',
    slot: 'default',
    physical: false,
    control: false,
    expiresAt,
    viewers: 0,
    auth: 'generated',
    viewAuth: null,
    ...overrides,
  };
}

/**
 * This Stim home's stimd with a net thread, as the CLI reaches it: it holds stimd's claim, answers the first frame on
 * stimd's socket, hands a `net.connect` connection to a WebSocket server that accepts `hello` and answers each
 * `share.list` with what `answer` returns then. Close it before the home is deleted.
 */
export async function serveShareList(
  answer: () => ShareListAnswer,
  seen: (method: string, params: unknown) => void = () => {},
): Promise<{ close: () => Promise<void> }> {
  const path = stimdSocket();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(stimdRunDir(), { recursive: true, mode: 0o700 });
  const attempt = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive', label: 'test stimd' });
  if (attempt.pending) releaseClaim(attempt.pending);
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (socket) =>
    socket.on('message', (data) => {
      const { id, method, params } = JSON.parse(String(data));
      if (method !== 'hello') seen(method, params);
      if (method === 'hello') return socket.send(JSON.stringify({ id, result: { server: { port: 1 } } }));
      const reply = method === 'share.list' ? answer() : { error: { code: 'unknown-method', message: method } };
      socket.send(JSON.stringify({ id, ...('error' in reply ? { error: reply.error } : { result: reply }) }));
    }),
  );
  const stimd = createNetServer((socket) => {
    let buffer = '';
    const data = (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const { op } = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (op === undefined) socket.write(`${JSON.stringify({ op: 'hello', kind: 'stimd' })}\n`);
        else if (op === 'net.connect') {
          socket.off('data', data);
          socket.write(`${JSON.stringify({ op: 'net.connected' })}\n`);
          http.emit('connection', socket);
          return;
        } else socket.end();
      }
    };
    socket.on('data', data);
  });
  await new Promise<void>((resolve) => stimd.listen(path, resolve));
  return {
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        stimd.close();
        releaseClaim(attempt.acquired ?? null);
        http.close(() => resolve());
      }),
  };
}
