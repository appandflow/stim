import { createWebSocket } from 'react-native-nitro-websockets';
import {
  createSession,
  type SessionClose,
  type SessionTiming,
  type VideoFormat,
  type VideoStream,
} from 'react-native-stim-session';

export type { SessionClose, SessionTiming, VideoFormat, VideoStream };

/**
 * How the session authenticates: a pairing token spends a pairing, sending `name` for the server's device record and
 * checking the server key against the QR code's `fingerprint`; a pinned server key returns.
 */
export type SocketAuth = { pairingToken: string; fingerprint?: string; name: string } | { serverKey: string };

/**
 * One Noise session with a Stim server: the native session runs the handshake and the encryption, and this side
 * sees only plaintext RPC messages. Video messages go straight to the `VideoStream` of their subscription.
 */
export interface StimSocket {
  /** The handshake completed with the server whose base64url static key is `serverKey`. */
  onopen: ((serverKey: string) => void) | null;
  onmessage: ((text: string) => void) | null;
  /** Reported exactly once; after `close()` nothing else is reported. */
  onclose: ((event: SessionClose) => void) | null;
  send(text: string): void;
  close(): void;
  videoStream(subscription: string): VideoStream;
  /** Development builds' timing of the messages this session received. */
  timing(): SessionTiming;
}

/** Opens a socket on react-native-nitro-websockets and runs the native Noise session over it. */
export function createSocket(url: string, auth: SocketAuth): StimSocket {
  const session = createSession();
  let ended = false;
  const socket: StimSocket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    send: (text) => session.send(text),
    close: () => {
      ended = true;
      session.close();
    },
    videoStream: (subscription) => session.videoStream(subscription),
    timing: () => session.timing(),
  };
  session.onOpen = (serverKey) => {
    if (!ended) socket.onopen?.(serverKey);
  };
  session.onMessage = (text) => {
    if (!ended) socket.onmessage?.(text);
  };
  session.onClose = (event) => {
    if (ended) return;
    ended = true;
    socket.onclose?.(event);
  };
  try {
    session.connect(createWebSocket(), url, auth);
  } catch (error) {
    ended = true;
    const reason = error instanceof Error ? error.message : String(error);
    setTimeout(() =>
      socket.onclose?.({ code: 1006, reason: '', serverAnswered: false, handshakeComplete: false, error: reason }),
    );
  }
  return socket;
}
