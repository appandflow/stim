import type { RemoteDiagnosis } from '@stim-cli/core/protocol';
import { isJsonObject, type TailnetPeer, type TailnetIdentity, type WrongTailnet } from '@stim-cli/core/state';
import type { Finding } from '../diagnostics/doctor.ts';

export type Transport =
  | { kind: 'http'; status: number }
  | { kind: 'refused' }
  | { kind: 'silent' }
  | { kind: 'tls'; message: string }
  | { kind: 'other'; message: string };

/** What a peer's `/health` says about a server that answered 503 (see `peerHealth` in stim-server). */
export interface PeerStartup {
  state: 'pending' | 'degraded';
  cause?: 'home-unreadable' | 'start-failed';
}

export type TailscaleReading = { running: true } | { running: false; code: TailscaleCode };

export type TailscaleCode = 'tailscale-unavailable' | 'tailscale-stopped' | 'tailscale-logged-out';

const SILENT_ERRORS = new Set(['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN']);

export function classifyTransport(error: Error & { code?: string }, status?: number): Transport {
  if (status !== undefined) return { kind: 'http', status };
  const code = error.code ?? '';
  if (code === 'ECONNREFUSED') return { kind: 'refused' };
  if (SILENT_ERRORS.has(code) || /handshake has timed out/i.test(error.message)) return { kind: 'silent' };
  if (
    /^(ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_SSL_)/.test(code) ||
    /certificate|SSL|TLS/i.test(error.message)
  )
    return { kind: 'tls', message: error.message };
  return { kind: 'other', message: error.message };
}

/** The `startup` a 503 `/health` body from a peer carries, when it is the shape stim-server sends. */
export function parsePeerStartup(body: unknown): PeerStartup | null {
  const startup = isJsonObject(body) && isJsonObject(body.startup) ? body.startup : null;
  if (!startup || (startup.state !== 'pending' && startup.state !== 'degraded')) return null;
  const cause = startup.cause === 'home-unreadable' || startup.cause === 'start-failed' ? startup.cause : undefined;
  return { state: startup.state, ...(cause ? { cause } : {}) };
}

export function readTailscale(status: unknown): TailscaleReading {
  if (!isJsonObject(status)) return { running: false, code: 'tailscale-unavailable' };
  switch (status.BackendState) {
    case 'Running':
      return { running: true };
    case 'NeedsLogin':
    case 'NeedsMachineAuth':
      return { running: false, code: 'tailscale-logged-out' };
    default:
      return { running: false, code: 'tailscale-stopped' };
  }
}

export function tailscaleDiagnosis(code: TailscaleCode): RemoteDiagnosis {
  switch (code) {
    case 'tailscale-logged-out':
      return {
        layer: 'tailscale',
        code,
        title: 'Tailscale signed out',
        message: 'Tailscale on this Mac is signed out, so it cannot reach any remote machine.',
        remedy: 'Sign in to Tailscale on this Mac (its menu bar app, or `tailscale up`), then run `stim doctor` again.',
      };
    case 'tailscale-stopped':
      return {
        layer: 'tailscale',
        code,
        title: 'Tailscale is off',
        message: 'Tailscale is turned off on this Mac, so it cannot reach any remote machine.',
        remedy: 'Turn on Tailscale on this Mac (its menu bar app, or `tailscale up`), then run `stim doctor` again.',
      };
    case 'tailscale-unavailable':
      return {
        layer: 'tailscale',
        code,
        title: 'Tailscale is off',
        message: 'Tailscale is not running on this Mac or is not installed, so it cannot reach any remote machine.',
        remedy: 'Install Tailscale or open it on this Mac and sign in, then run `stim doctor` again.',
      };
  }
}

const tailnetLabel = (tailnet: TailnetIdentity) =>
  tailnet.suffix ? `${tailnet.name} (${tailnet.suffix})` : tailnet.name;

/** A machine that is not on the tailnet this Mac is signed in to now, but was on the one it was signed in to at approval. */
export function wrongTailnetDiagnosis(entry: string, wrong: WrongTailnet): RemoteDiagnosis {
  const owner = wrong.owner ? `, or to ${wrong.owner}, the tailnet that owns ${entry}` : '';
  return {
    layer: 'peer',
    code: 'peer-wrong-tailnet',
    title: 'Other Tailscale account',
    message: `This Mac asked ${entry} for access while it was signed in to the Tailscale tailnet ${tailnetLabel(wrong.recorded)}. This Mac is signed in to ${tailnetLabel(wrong.current)} now, and no peer there is named ${entry}.`,
    remedy: `Switch Tailscale on this Mac to ${tailnetLabel(wrong.recorded)}${owner}, then run \`stim doctor\` again.`,
  };
}

export function notOnTailnetDiagnosis(entry: string, ambiguous: boolean, wrong?: WrongTailnet | null): RemoteDiagnosis {
  if (wrong && !ambiguous) return wrongTailnetDiagnosis(entry, wrong);
  return {
    layer: 'peer',
    code: ambiguous ? 'peer-ambiguous' : 'peer-not-found',
    title: ambiguous ? 'Name is ambiguous' : 'Not on the tailnet',
    message: ambiguous ? `Several peers on this tailnet match ${entry}.` : `No peer on this tailnet is named ${entry}.`,
    remedy: ambiguous
      ? `Use the full MagicDNS name in remote.machines (see \`tailscale status\`).`
      : `Check the name in \`tailscale status\`, or sign in to Tailscale on ${entry} with the same account.`,
  };
}

function ago(iso: string | undefined, now: number): string | null {
  const then = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(then) || then <= 0) return null;
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const sentence = (text: string) => text.replace(/\s+$/, '').replace(/([^.!?])$/, '$1.');

export interface UnreachableInput {
  entry: string;
  /** The peer entry from `tailscale status`. */
  peer: TailnetPeer;
  port: number;
  /** Why the connection failed, when nothing below the handshake explains it. */
  reason: string;
  /** What the connection did; absent when it got past the transport. */
  transport?: Transport;
  /** The `startup` of the peer's `/health`, read after a 503. */
  startup?: PeerStartup | null;
  /** Whether `tailscale ping` reached the peer, read after a silent connection; undefined when not asked. */
  pinged?: boolean;
  now?: number;
}

/**
 * Tailscale's `Online` lags a reachable peer, so `peer-offline` needs a silent connection; any other outcome,
 * including one past the transport (no `transport`), shows the peer answered.
 */
export function diagnoseUnreachable(input: UnreachableInput): RemoteDiagnosis {
  const { entry, peer, port, transport, now = Date.now() } = input;
  const route = `https port ${port}`;
  if (transport?.kind === 'silent' && input.pinged === true) {
    return {
      layer: 'server',
      code: 'server-no-answer',
      title: 'Server not answering',
      message: `${entry} answers on Tailscale, but its serve route and stim-server sent no reply in time. stim-server may be starting, stalled or restarting.`,
      remedy: `On ${entry}, run \`stim-server service status\`; it reports a restart loop or a Stim home it is still reading, and the log file to read.`,
    };
  }
  if (peer.online === false && transport?.kind === 'silent') {
    const seen = ago(peer.lastSeen, now);
    return {
      layer: 'peer',
      code: 'peer-offline',
      title: 'Mac is offline',
      message: `${entry} is offline on Tailscale${seen ? ` (last seen ${seen})` : ''}.`,
      remedy: `Wake ${entry} or check that it is powered on, connected to a network and signed in to Tailscale, then run \`stim doctor\` again.`,
    };
  }
  if (transport?.kind === 'refused') {
    return {
      layer: 'route',
      code: 'route-missing',
      title: 'No serve route',
      message: `${entry} answers on the tailnet, but nothing accepts connections on ${route}, so it has no tailscale serve route for stim-server.`,
      remedy: `On ${entry}, run \`stim-server service status\`; \`stim-server service install --serve\` creates the route.`,
    };
  }
  if (transport?.kind === 'silent') {
    return {
      layer: 'peer',
      code: 'peer-no-answer',
      title: 'Mac not answering',
      message: `${entry} did not answer the connection, and Tailscale does not list it as offline.`,
      remedy: `Check that ${entry} is awake and its network is up; \`tailscale ping ${entry}\` on this Mac tests the path.`,
    };
  }
  if (transport?.kind === 'tls') {
    return {
      layer: 'route',
      code: 'route-tls',
      title: 'Route certificate',
      message: `The tailscale serve route on ${entry} (${route}) did not present a certificate this Mac accepts: ${sentence(transport.message)}`,
      remedy: `On ${entry}, run \`tailscale serve status\`, then \`stim-server service install --serve\` to recreate the route.`,
    };
  }
  if (transport?.kind === 'http') {
    const { status } = transport;
    if (status === 502) {
      return {
        layer: 'server',
        code: 'server-not-running',
        title: 'Server not running',
        message: `Tailscale and the serve route on ${entry} work, but nothing listens behind the route: stim-server is not running there (HTTP 502).`,
        remedy: `On ${entry}, run \`stim-server service status\`; \`stim-server service install --serve\` starts it and keeps it running.`,
      };
    }
    if (status === 503) {
      const startup = input.startup;
      const why =
        startup?.cause === 'home-unreadable'
          ? ' It cannot read its Stim home, usually because the disk holding ~/.stim is disconnected or not responding.'
          : startup?.cause === 'start-failed'
            ? ' It failed while starting.'
            : startup?.state === 'pending'
              ? ' It is still starting.'
              : '';
      const check =
        startup?.cause === 'home-unreadable'
          ? `Check the disk that holds the Stim home on ${entry} (reconnect or wake an external drive); stim-server serves again by itself once it answers. \`stim-server service status\` there shows the exact reason.`
          : startup?.state === 'pending'
            ? `Wait a few seconds and run \`stim doctor\` again.`
            : `On ${entry}, run \`stim-server service status\` for the reason; the log file it prints has the rest.`;
      return {
        layer: 'server',
        code: 'server-not-ready',
        title: 'Server not ready',
        message: `stim-server on ${entry} is running but is not serving clients (HTTP 503).${why}`,
        remedy: check,
      };
    }
    return {
      layer: 'route',
      code: 'route-http-error',
      title: `Route answers ${status}`,
      message: `The tailscale serve route on ${entry} (${route}) answered HTTP ${status}, which stim-server does not send for a connection.`,
      remedy: `On ${entry}, run \`tailscale serve status\` and check what the route on port ${port} points to.`,
    };
  }
  return {
    layer: 'server',
    code: 'connect-failed',
    title: 'Not answering',
    message: `Could not connect to stim-server on ${entry}: ${sentence(input.reason)}`,
    remedy: `On ${entry}, run \`stim-server service status\`. To keep it running there, run \`stim-server service install --serve\`.`,
  };
}

/**
 * Why a `local:` machine did not connect. Nothing below stim-server's own port is in the way, so the causes are the
 * network, the machine's firewall, or a server that does not listen on that address.
 */
export function diagnoseLocalUnreachable(
  input: Pick<UnreachableInput, 'entry' | 'port' | 'reason' | 'transport' | 'startup'>,
): RemoteDiagnosis {
  const { entry, port, transport } = input;
  if (transport?.kind === 'refused') {
    return {
      layer: 'server',
      code: 'lan-not-listening',
      title: 'Not listening on the local network',
      message: `${entry} answers on the local network, but nothing accepts connections on port ${port}: its stim-server is not running or does not listen on that address.`,
      remedy: `On ${entry}, run \`stim-server service status\`, and check that server.lanAddresses names the network interface or address this machine reaches (\`npx --yes stim settings get server.lanAddresses\`). Its stim-server log names each entry it cannot use.`,
    };
  }
  if (transport?.kind === 'silent') {
    return {
      layer: 'peer',
      code: 'lan-no-answer',
      title: 'Not answering',
      message: `${entry} did not answer a connection on port ${port}.`,
      remedy: `Check that ${entry} is awake, on the same network as this machine and has that address. On a Mac, the macOS firewall drops connections until a person allows incoming connections for stim-server's node there (System Settings > Network > Firewall > Options).`,
    };
  }
  if (transport?.kind === 'http' && transport.status === 503)
    return diagnoseUnreachable({ ...input, peer: { nodeId: '', dnsName: entry, address: entry } });
  return {
    layer: 'server',
    code: 'connect-failed',
    title: 'Not answering',
    message: `Could not connect to stim-server on ${entry}: ${sentence(input.reason)}`,
    remedy: `On ${entry}, run \`stim-server service status\`. To keep it running there, run \`stim-server service install\`.`,
  };
}

/** The doctor finding for a `local:` machine whose server key no person has confirmed, so Stim has not pinned it. */
export function unconfirmedKeyFinding(code: string, entry: string, fingerprint: string): Finding {
  return {
    code,
    level: 'note',
    title: `Remote machine ${entry} needs its server key confirmed`,
    detail: `${entry} approved this machine and answered with the stim-server key fingerprint ${fingerprint}. On the local network nothing vouches for that key, so Stim pins it only after a person checks it against the fingerprint \`stim-server setup\` printed there. Until then this machine does not use ${entry}.`,
    fix: `Run \`stim remote list\` in a terminal here and answer y only if the fingerprint matches. If it does not, another machine answered at that address: do not confirm, and check the address in remote.machines.`,
  };
}

export function diagnosisFinding(code: string, entry: string, diagnosis: RemoteDiagnosis): Finding {
  return {
    code,
    level: 'note',
    title: `Remote machine ${entry}: ${diagnosis.title}`,
    detail: diagnosis.message,
    fix: diagnosis.remedy,
  };
}
