import { loadKind, type PluginSource } from '@stim-cli/core/plugin-loader';
import type { IncomingMessage } from 'node:http';

export const TRANSPORT_API_VERSION = 1 as const;

const LOAD_TIMEOUT_MS = 10_000;

export interface TransportTraits {
  /** Traffic stays on a private overlay whose source addresses identify the sending machine. */
  privateNetwork: boolean;
  /** Where TLS ends: on this machine, at a provider's edge, or nowhere. */
  tls: 'end-to-end' | 'edge' | 'none';
  /** `identify` names the machine a connection comes from, so a device token can be bound to it. */
  peerIdentity: boolean;
}

/** The machine a connection comes from, as the transport identifies it. `id` stays the same across renames. */
export interface TransportIdentity {
  id: string;
  name: string;
  user: string;
}

export interface TransportPeer {
  /** The connection's source address as stim-server sees it, after any proxy the transport runs. */
  address: string;
  request: IncomingMessage;
}

export interface Transport {
  id: string;
  traits: TransportTraits;
  /** The addresses stim-server listens on, besides loopback, for clients this transport carries. */
  bindAddresses?(): string[];
  /** Calls `listener` whenever `bindAddresses` or the transport's state may have changed. */
  watch?(listener: () => void): () => void;
  identify?(peer: TransportPeer): Promise<TransportIdentity | null>;
  close?(): void;
}

export interface TransportInput {
  env: NodeJS.ProcessEnv;
  options: Record<string, unknown>;
}

export interface TransportModule {
  apiVersion: typeof TRANSPORT_API_VERSION;
  id: string;
  createTransport(input: TransportInput): Transport | Promise<Transport>;
}

export type LoadTransportResult = { transport: Transport } | { unavailable: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CAPABILITIES = ['bindAddresses', 'watch', 'identify', 'close'] as const;

function isTransport(value: unknown): value is Transport {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isRecord(value.traits) &&
    CAPABILITIES.every((name) => value[name] === undefined || typeof value[name] === 'function')
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
