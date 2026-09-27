import { WebSocket } from 'ws';

export interface OwnedPage {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

type Send = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<Record<string, unknown>>;

function connect(url: string, timeoutMs: number): Promise<{ socket: WebSocket; send: Send }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    const pending = new Map<
      number,
      { resolve: (value: Record<string, unknown>) => void; reject: (e: Error) => void }
    >();
    let next = 1;
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`DevTools did not accept a connection at ${url} within ${timeoutMs} ms.`));
    }, timeoutMs);
    socket.on('message', (data) => {
      let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
      try {
        message = JSON.parse(String(data)) as typeof message;
      } catch {
        return;
      }
      const waiter = typeof message.id === 'number' ? pending.get(message.id) : undefined;
      if (!waiter) return;
      pending.delete(message.id!);
      if (message.error) waiter.reject(new Error(message.error.message ?? 'DevTools command failed.'));
      else waiter.resolve(message.result ?? {});
    });
    socket.on('close', () => {
      for (const waiter of pending.values()) waiter.reject(new Error('The DevTools connection closed.'));
      pending.clear();
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('open', () => {
      clearTimeout(timer);
      resolve({
        socket,
        send: (method, params = {}, sessionId) =>
          new Promise((resolveCommand, rejectCommand) => {
            if (socket.readyState !== socket.OPEN) return rejectCommand(new Error('The DevTools connection closed.'));
            const id = next++;
            const commandTimer = setTimeout(() => {
              pending.delete(id);
              rejectCommand(new Error(`DevTools command ${method} timed out.`));
            }, timeoutMs);
            pending.set(id, {
              resolve: (value) => {
                clearTimeout(commandTimer);
                resolveCommand(value);
              },
              reject: (error) => {
                clearTimeout(commandTimer);
                rejectCommand(error);
              },
            });
            socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          }),
      });
    });
  });
}

/**
 * Connects to the page `targetId` of the Chrome at loopback `endpoint`, only when `SystemInfo.getProcessInfo`
 * names `chromePid` as its browser process: the rule the CLI's `connectOwnedBrowser` and `stim-frames` apply.
 */
export async function connectOwnedPage(
  endpoint: string,
  chromePid: number,
  targetId: string,
  timeoutMs: number,
): Promise<OwnedPage> {
  const port = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(endpoint)?.[1];
  if (!port) throw new Error(`${endpoint} is not a loopback DevTools endpoint.`);
  const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
  const { webSocketDebuggerUrl } = ((await response.json().catch(() => null)) ?? {}) as {
    webSocketDebuggerUrl?: unknown;
  };
  if (typeof webSocketDebuggerUrl !== 'string' || !webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${port}/`)) {
    throw new Error(`Port ${port} does not serve a browser DevTools endpoint.`);
  }
  const browser = await connect(webSocketDebuggerUrl, timeoutMs);
  try {
    const { processInfo } = (await browser.send('SystemInfo.getProcessInfo')) as {
      processInfo?: { type: string; id: number }[];
    };
    const found = processInfo?.find((entry) => entry.type === 'browser')?.id;
    if (found !== chromePid) {
      throw new Error(
        `Port ${port} is served by browser pid ${found ?? 'unknown'}, not the owned Chrome ${chromePid}.`,
      );
    }
    const { sessionId } = (await browser.send('Target.attachToTarget', { targetId, flatten: true })) as {
      sessionId: string;
    };
    return { send: (method, params) => browser.send(method, params, sessionId), close: () => browser.socket.close() };
  } catch (error) {
    browser.socket.close();
    throw error;
  }
}
