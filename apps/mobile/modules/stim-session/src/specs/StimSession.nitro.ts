import type {
  AnyHybridObject,
  HybridObject,
  HybridView,
  HybridViewMethods,
  HybridViewProps,
} from 'react-native-nitro-modules';

export interface SessionOptions {
  /** The base64url 32-byte pairing token. With it the session pairs (`XXpsk2`); without it, it returns (`XX`). */
  pairingToken?: string;
  /**
   * The server's base64url 32-byte X25519 public key: the key pinned when this phone paired, or the one the QR code
   * carries. Required without `pairingToken`. The session refuses any other key.
   */
  serverKey?: string;
}

export interface SessionClose {
  code: number;
  reason: string;
  /** Whether the server answered the handshake's first message before the close. */
  serverAnswered: boolean;
  /** Whether the handshake completed before the close. */
  handshakeComplete: boolean;
  /** Set when this side ended the session: a handshake failure, a message that failed to decrypt, a wrong key. */
  error?: string;
}

/**
 * One Noise session with stim-server over a react-native-nitro-websockets socket. It installs itself as the socket's
 * handlers, runs the handshake with the client key it keeps in the Keychain or Keystore, and passes only plaintext
 * RPC messages to JavaScript. Video messages go to the {@link VideoStream} of their subscription.
 */
export interface StimSession extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  /** The handshake completed; `serverKey` is the server's base64url static key, for pinning. */
  onOpen: ((serverKey: string) => void) | undefined;
  onMessage: ((text: string) => void) | undefined;
  /** Called once, after which the session sends and receives nothing. */
  onClose: ((event: SessionClose) => void) | undefined;
  /** `socket` is a new `HybridWebSocket` from react-native-nitro-websockets that has not connected. */
  connect(socket: AnyHybridObject, url: string, options: SessionOptions): void;
  /** Encrypts and sends one RPC message. Throws before the handshake completes and above 64 KiB. */
  send(text: string): void;
  close(): void;
  /** The stream that receives this subscription's video messages, replacing any earlier one for it. */
  videoStream(subscription: string): VideoStream;
  /** Timing of the messages received so far, in development builds; `enabled` is false in release builds. */
  timing(): SessionTiming;
}

/**
 * Aggregates on the client's monotonic clock, from the socket callback that delivered each message. In development
 * builds only, for comparing video paths.
 */
export interface SessionTiming {
  enabled: boolean;
  messages: number;
  videoMessages: number;
  /** Video messages for a subscription without a live stream. */
  droppedVideoMessages: number;
  /** Socket callback to decrypted. */
  meanDecryptMs: number;
  maxDecryptMs: number;
  /** Socket callback to handed to the stream, which passes it to the view's decoder queue. */
  meanRouteMs: number;
  maxRouteMs: number;
}

export interface NoiseMessageVector {
  payload: string;
  ciphertext: string;
}

/** One vector of packages/core/__tests__/fixtures/noise-vectors.json, hex encoded. */
export interface NoiseVector {
  name: string;
  psk: boolean;
  initPrologue: string;
  initStatic: string;
  initEphemeral: string;
  initPsk?: string;
  respPrologue: string;
  respStatic: string;
  respEphemeral: string;
  respPsk?: string;
  handshakeHash?: string;
  messages: NoiseMessageVector[];
}

/** One vector of packages/core/__tests__/fixtures/noise-framing-vectors.json, hex encoded. */
export interface FramingVector {
  key: string;
  counter: string;
  text: boolean;
  data: string;
  ciphertext: string;
}

export interface ThroughputResult {
  /** Plaintext megabytes per second through decryption, header parsing and routing to a stream. */
  megabytesPerSecond: number;
  messages: number;
}

/** Checks the native Noise implementation in development builds. */
export interface NoiseCheck extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  /** Returns one line per failing vector; empty when every vector matches. */
  runVectors(vectors: NoiseVector[], framing: FramingVector[]): string[];
  /** Decrypts `count` encrypted video messages of `bytes` each and routes them to a stream that drops them. */
  measureThroughput(bytes: number, count: number): ThroughputResult;
}

export type VideoPosture = 'folded' | 'unfolded';

export interface VideoFormat {
  width: number;
  height: number;
  posture?: VideoPosture;
  artworkTurns?: number;
  /**
   * Increases when a format with `artworkTurns` differs from the last one. The view clears its old pixels for it and
   * then calls `onOrientationCleared` with it.
   */
  generation: number;
}

export interface VideoProgress {
  /** The newest frame's capture time, epoch milliseconds on the Mac's clock. */
  capturedAt: number;
  frames: number;
  bytes: number;
  /** Arrival minus capture time of the newest frame, in milliseconds. */
  latencyMs: number;
}

/**
 * The video of one `frames.subscribe` subscription. The session feeds it natively; JavaScript calls `push` only in
 * development builds. Call `dispose()` when the subscription ends: it releases the stream's buffers and detaches the
 * view.
 */
export interface VideoStream extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  /** One stim-server video message: the header, then one Annex-B H.264 access unit. */
  push(packet: ArrayBuffer): void;
  /** The size or posture changed, on the first keyframe and after. */
  onFormat: ((format: VideoFormat) => void) | undefined;
  /** Frames that arrived since the last call, at most every 200 ms. */
  onProgress: ((progress: VideoProgress) => void) | undefined;
  /** Timing of this stream's frames, in development builds; `enabled` is false in release builds. */
  timing(): VideoTiming;
}

/** Aggregates on the client's monotonic clock, from the moment the stream received each frame. */
export interface VideoTiming {
  enabled: boolean;
  received: number;
  /** Frames submitted to the decoder: enqueued on the iOS display layer, queued to the Android MediaCodec. */
  decoded: number;
  /**
   * Frames shown: on Android when MediaCodec releases the output buffer to the surface; on iOS, where
   * AVSampleBufferDisplayLayer reports no per-frame presentation, when the frame is enqueued.
   */
  presented: number;
  /** Frames dropped: with no view and no keyframe to start from, a full backlog, or a decoder waiting for a keyframe. */
  dropped: number;
  /** Received to submitted to the decoder. */
  meanDecodeQueueMs: number;
  maxDecodeQueueMs: number;
  /** Received to presented. */
  meanPresentMs: number;
  maxPresentMs: number;
}

export interface StimVideoViewProps extends HybridViewProps {
  /** The stream this view decodes. Replacing or removing it detaches the view. */
  stream?: VideoStream;
  /** The decoder lost its state, as after the app was in the background, and waits for a keyframe. */
  onKeyframeNeeded?: () => void;
  /** Old pixels have been cleared for this orientation generation; newly decoded pixels belong to it. */
  onOrientationCleared?: (generation: number) => void;
}

export type StimVideoView = HybridView<StimVideoViewProps, HybridViewMethods, { ios: 'swift'; android: 'kotlin' }>;
