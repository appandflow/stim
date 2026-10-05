import type { ConnectionOptions } from 'node:tls';
import { WebSocket, type ClientOptions } from 'ws';
import { isJsonObject, parseMachine, pinnedEndpoint as corePinnedEndpoint, type Endpoint } from '@stim-cli/core/state';
export { parseMachine, findPeer, endpoint, type TailnetPeer, type Endpoint } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';

const MAC_APP_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const HELLO_TIMEOUT_MS = 10_000;

export type HelloReply =
  | {
      result: {
        host?: { name: string; screenRecording: boolean; accessibility: boolean } | null;
        capabilities: string[];
        device: { id: string; name: string };
        deviceToken?: string;
        approval?: { state: 'pending'; expiresAt: string };
      };
    }
  | { error: { code: string; message: string } }
  | { failed: string };

export interface TailnetMachineIo {
  /** `tailscale status --json`, or null when Tailscale is not running. */
  status: () => unknown;
  hello: (endpoint: Endpoint, auth: Record<string, string>) => Promise<HelloReply>;
}

function tailscaleStatus(): unknown {
  for (const binary of ['tailscale', MAC_APP_TAILSCALE]) {
    const output = getExecutor().runFileQuiet(binary, ['status', '--json'], { timeoutMs: 5000 });
    if (output === null) continue;
    try {
      const status = JSON.parse(output) as unknown;
      return isJsonObject(status) && status.BackendState === 'Running' ? status : null;
    } catch {
      return null;
    }
  }
  return null;
}

function hello({ url, servername, host }: Endpoint, auth: Record<string, string>): Promise<HelloReply> {
  return new Promise((resolve) => {
    const options: ClientOptions & ConnectionOptions = {
      handshakeTimeout: HELLO_TIMEOUT_MS,
      servername,
      headers: { Host: host },
    };
    const socket = new WebSocket(url, options);
    const done = (reply: HelloReply) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.close();
      resolve(reply);
    };
    const timer = setTimeout(() => done({ failed: 'no reply in time' }), HELLO_TIMEOUT_MS);
    socket.on('open', () => {
      const client = { name: 'stim', version: '1' };
      socket.send(JSON.stringify({ id: 1, method: 'hello', params: { protocol: 1, client, auth } }));
    });
    socket.on('message', (data) => {
      let message: unknown;
      try {
        message = JSON.parse(String(data));
      } catch {
        message = null;
      }
      if (isJsonObject(message) && ('result' in message || 'error' in message)) return done(message as HelloReply);
      done({ failed: 'the reply was not a hello result' });
    });
    socket.on('error', (error) => done({ failed: error.message }));
    socket.on('close', () => done({ failed: 'the connection closed before a reply' }));
  });
}

export const realIo: TailnetMachineIo = { status: tailscaleStatus, hello };

export function pinnedEndpoint(
  credential: { machine: string; nodeId: string },
  status: () => unknown = tailscaleStatus,
): Endpoint | string {
  return corePinnedEndpoint(credential, parseMachine(credential.machine) ? status() : null);
}
