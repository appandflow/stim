import { WebSocket } from 'ws';

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpConnection {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  onEvent(listener: (event: CdpEvent) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

const COMMAND_TIMEOUT_MS = 15_000;

function connectCdp(url: string, { timeoutMs = 5000 }: { timeoutMs?: number } = {}): Promise<CdpConnection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    const pending = new Map<
      number,
      { resolve: (value: Record<string, unknown>) => void; reject: (e: Error) => void }
    >();
    const eventListeners: ((event: CdpEvent) => void)[] = [];
    const closeListeners: (() => void)[] = [];
    let nextId = 1;
    let closed = false;
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`DevTools did not accept a connection at ${url} within ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on('message', (data) => {
      let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } } & Partial<CdpEvent>;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (typeof message.id === 'number') {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? 'DevTools command failed'));
        else waiter.resolve(message.result ?? {});
        return;
      }
      if (typeof message.method === 'string') {
        const event: CdpEvent = {
          method: message.method,
          params: message.params ?? {},
          ...(message.sessionId ? { sessionId: message.sessionId } : {}),
        };
        for (const listener of eventListeners) listener(event);
      }
    });
    socket.on('close', () => {
      closed = true;
      for (const waiter of pending.values()) waiter.reject(new Error('DevTools connection closed'));
      pending.clear();
      for (const listener of closeListeners) listener();
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('open', () => {
      clearTimeout(timer);
      resolve({
        send(method, params = {}, sessionId) {
          if (closed) return Promise.reject(new Error('DevTools connection closed'));
          const id = nextId++;
          return new Promise((resolveCommand, rejectCommand) => {
            const commandTimer = setTimeout(() => {
              pending.delete(id);
              rejectCommand(new Error(`DevTools command ${method} timed out`));
            }, COMMAND_TIMEOUT_MS);
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
          });
        },
        onEvent(listener) {
          eventListeners.push(listener);
        },
        onClose(listener) {
          if (closed) listener();
          else closeListeners.push(listener);
        },
        close() {
          socket.close();
        },
      });
    });
  });
}

/**
 * Connects to the browser DevTools endpoint on loopback `port` only when the process serving it is `chromePid`,
 * the Chrome Stim started. Chrome reports its own browser process through `SystemInfo.getProcessInfo`.
 */
export async function connectOwnedBrowser(port: number, chromePid: number): Promise<CdpConnection> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
  const { webSocketDebuggerUrl } = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (typeof webSocketDebuggerUrl !== 'string' || !webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${port}/`)) {
    throw new Error(`port ${port} does not serve a browser DevTools endpoint`);
  }
  const cdp = await connectCdp(webSocketDebuggerUrl);
  try {
    const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as {
      processInfo?: { type: string; id: number }[];
    };
    const browser = processInfo?.find((entry) => entry.type === 'browser')?.id;
    if (browser !== chromePid) {
      throw new Error(
        `port ${port} is served by browser pid ${browser ?? 'unknown'}, not the owned Chrome ${chromePid}`,
      );
    }
    return cdp;
  } catch (error) {
    cdp.close();
    throw error;
  }
}
