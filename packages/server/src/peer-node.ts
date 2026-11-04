const FOUND_TTL_MS = 30_000;

export function cachedPeerNode<Request>(
  lookup: (request: Request, address: string) => Promise<string | null>,
  options: { ttlMs?: number; now?: () => number } = {},
): (request: Request, address: string) => Promise<string | null> {
  const ttlMs = options.ttlMs ?? FOUND_TTL_MS;
  const now = options.now ?? Date.now;
  const found = new Map<string, { node: string; until: number }>();
  const pending = new Map<string, Promise<string | null>>();
  return (request, address) => {
    const known = found.get(address);
    if (known && known.until > now()) return Promise.resolve(known.node);
    let shared = pending.get(address);
    if (!shared) {
      shared = lookup(request, address)
        .then((node) => {
          if (node) found.set(address, { node, until: now() + ttlMs });
          else found.delete(address);
          return node;
        })
        .finally(() => pending.delete(address));
      pending.set(address, shared);
    }
    return shared;
  };
}
