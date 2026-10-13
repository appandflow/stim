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
  transport: string;
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

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
}

function hasFactory(
  value: Record<string, unknown>,
): value is Record<string, unknown> & Pick<TransportModule, 'createTransport'> {
  return typeof value.createTransport === 'function';
}

function isTransport(value: unknown): value is Transport {
  return isRecord(value) && typeof value.id === 'string' && isRecord(value.traits);
}

function moduleCandidate(namespace: unknown): unknown {
  if (!isRecord(namespace)) return namespace;
  return 'apiVersion' in namespace ? namespace : namespace.default;
}

async function importTransport(
  reference: string,
  load: () => Promise<unknown>,
  input: TransportInput,
): Promise<LoadTransportResult> {
  let namespace: unknown;
  try {
    namespace = await load();
  } catch (error) {
    return { unavailable: `${reference} is not installed: ${reason(error)}` };
  }
  const candidate = moduleCandidate(namespace);
  if (!isRecord(candidate) || candidate.apiVersion !== TRANSPORT_API_VERSION) {
    const found = isRecord(candidate) ? candidate.apiVersion : candidate;
    return {
      unavailable: `${reference}: expected apiVersion ${TRANSPORT_API_VERSION}, found ${JSON.stringify(found)}`,
    };
  }
  if (!hasFactory(candidate)) {
    return { unavailable: `${reference} does not export createTransport()` };
  }
  let transport: unknown;
  try {
    transport = await candidate.createTransport(input);
  } catch (error) {
    return { unavailable: `${reference}: createTransport() failed: ${reason(error)}` };
  }
  if (!isTransport(transport)) {
    return { unavailable: `${reference}: createTransport() did not return a transport` };
  }
  return { transport };
}

/**
 * Imports the transport module `reference` with `load` and creates its transport. Never throws: a missing module, a
 * wrong `apiVersion`, a failing factory, or a load that takes longer than `timeoutMs` comes back as `unavailable`
 * with the reason.
 */
export async function loadTransport({
  reference,
  load,
  input,
  timeoutMs = LOAD_TIMEOUT_MS,
}: {
  reference: string;
  load: () => Promise<unknown>;
  input: TransportInput;
  timeoutMs?: number;
}): Promise<LoadTransportResult> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<LoadTransportResult>((resolve) => {
    timer = setTimeout(() => resolve({ unavailable: `${reference} did not load within ${timeoutMs}ms` }), timeoutMs);
  });
  try {
    return await Promise.race([
      importTransport(reference, load, input).catch((error: unknown) => ({ unavailable: reason(error) })),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
