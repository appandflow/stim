import { loadKind, type PluginSource } from '@stim-cli/core/plugin-loader';

export const TRANSPORT_API_VERSION = 1 as const;

const LOAD_TIMEOUT_MS = 10_000;

/** The machine a connection comes from, as the transport identifies it. `id` stays the same across renames. */
export interface TransportIdentity {
  id: string;
  name: string;
  user: string;
}

/** The request headers of a connection, as Node reports them. */
export type TransportHeaders = Record<string, string | string[] | undefined>;

export interface TransportPeer {
  /** The connection's source address as stim-server sees it, after any proxy the transport runs. */
  address: string;
  headers: TransportHeaders;
}

/** What `watch` delivers: every address stim-server listens on, besides loopback, for this transport now. */
export interface TransportWatchEvent {
  addresses: string[];
}

/** A machine a dialer names, resolved to the endpoint to connect to. */
export interface TransportEndpoint {
  url: string;
  servername: string;
  host: string;
}

export interface TransportResolveInput {
  /** The machine's name in this transport's own terms, without the transport id. */
  name: string;
  /** What Stim recorded when it paired with the machine. */
  credential: { machine: string; address?: string; tailnet?: { name: string; suffix?: string; id?: string } };
}

export interface TransportExposeInput {
  /** The local port to make reachable. */
  port: number;
}

/** Whether `port` is reachable from outside this machine through the transport, or why that is not known. */
export type TransportExposure =
  | { state: 'routed'; port: number }
  | { state: 'funneled'; ports: number[]; port: number }
  | { state: 'missing'; port: number }
  | { state: 'unknown'; reason: string; port: number };

/**
 * Every argument and result of a member is structured-clone-safe data, so a transport can run in a worker thread
 * behind a `MessagePort`. `watch`'s listener and `close` are the in-thread form of messages the bridge carries.
 */
export interface Transport {
  id: string;
  /** The addresses stim-server listens on, besides loopback, for clients this transport carries. */
  bindAddresses?(): string[];
  /** Calls `listener` with the new addresses whenever `bindAddresses` or the transport's state may have changed. */
  watch?(listener: (event: TransportWatchEvent) => void): () => void;
  identify?(peer: TransportPeer): Promise<TransportIdentity | null>;
  /** Makes a local port reachable from outside this machine, as ngrok and cloudflared do. */
  expose?(input: TransportExposeInput): Promise<TransportExposure>;
  unexpose?(input: TransportExposeInput): Promise<void>;
  /** The endpoint to dial a machine of this transport, or why there is none. */
  resolve?(input: TransportResolveInput): Promise<TransportEndpoint | { unresolved: string }>;
  close?(): void | Promise<void>;
}

export interface TransportInput {
  env: NodeJS.ProcessEnv;
  options: Record<string, unknown>;
}

export interface TransportModule {
  id: string;
  createTransport(input: TransportInput): Transport | Promise<Transport>;
}

export type LoadTransportResult = { transport: Transport } | { unavailable: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TRANSPORT_CAPABILITIES = [
  'bindAddresses',
  'watch',
  'identify',
  'expose',
  'unexpose',
  'resolve',
  'close',
] as const;

function isTransport(value: unknown): value is Transport {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    TRANSPORT_CAPABILITIES.every((name) => value[name] === undefined || typeof value[name] === 'function')
  );
}

/** Loads a manifest-compatible transport, awaiting its factory. Failures resolve to `unavailable`. */
export async function loadTransport({
  reference,
  load,
  manifest,
  input,
  timeoutMs = LOAD_TIMEOUT_MS,
}: PluginSource & {
  reference: string;
  input: TransportInput;
  timeoutMs?: number;
}): Promise<LoadTransportResult> {
  const loaded = await loadKind<Transport>({
    reference,
    kind: 'transport',
    version: TRANSPORT_API_VERSION,
    source: { load, manifest },
    factory: 'createTransport',
    input,
    accept(value) {
      if (!isTransport(value)) throw new Error('createTransport() did not return a transport');
      return value;
    },
    dispose: (value) => value.close?.(),
    timeoutMs,
  });
  return 'value' in loaded ? { transport: loaded.value } : loaded;
}
