import { createWebSocket } from 'react-native-nitro-websockets';
import { TextDecoder } from 'react-native-nitro-text-decoder';

/** The part of a WebSocket a Stim connection uses. Binary messages arrive as an `ArrayBuffer`. */
export interface StimSocket {
  onopen: (() => void) | null;
  onmessage: ((message: { data: string | ArrayBuffer }) => void) | null;
  onclose: (() => void) | null;
  send(text: string): void;
  close(): void;
}

const utf8 = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

/**
 * Opens a socket on react-native-nitro-websockets. Its native side reads a handler when an event fires, so the
 * handlers are bound before `connect`: an event that fires before they are set is lost, and a refused loopback
 * connection can fail that fast.
 */
export function createSocket(url: string): StimSocket {
  const native = createWebSocket();
  const socket: StimSocket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    send: (text) => native.send(text),
    close: () => native.close(1000, ''),
  };
  native.onOpen = () => socket.onopen?.();
  native.onMessage = (message) =>
    socket.onmessage?.({ data: message.isBinary ? message.data : utf8.decode(message.data) });
  native.onClose = () => socket.onclose?.();
  native.connect(url, [], {});
  return socket;
}
