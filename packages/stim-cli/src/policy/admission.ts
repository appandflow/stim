/** A build slot as its claim reads: its index, and whether its holder is provably alive or cannot be verified. */
export interface SlotReading {
  index: number | null;
  alive: boolean;
  unresolved: boolean;
}

/** The slots below `max` a build could take that are busy: held by a live holder or by one that cannot be verified. */
export function busySlots<T extends SlotReading>(slots: readonly T[], max: number): T[] {
  return slots.filter(({ index, alive, unresolved }) => index !== null && index < max && (alive || unresolved));
}

/**
 * The turn of the waiter at 1-based queue `position`, given the busy slots: only the first `max` positions minus the
 * live-held slots try the atomic claim, so a build never takes a slot ahead of an older one. `unverified` are the busy
 * slots whose holder cannot be verified, which start the queue's liveness ceiling.
 */
export function slotTurn<T extends SlotReading>(
  position: number,
  max: number,
  busy: readonly T[],
): { claim: boolean; unverified: T[] } {
  return {
    claim: position <= max - busy.filter((slot) => slot.alive).length,
    unverified: busy.filter((slot) => slot.unresolved),
  };
}

/** A device lease as granting it reads: who holds it, for which slot (absent for `default`), under which token, until when. */
export interface LeaseReading {
  holder: string;
  slot?: string;
  token: string;
  expiresAt: string;
}

export type LeaseKind = 'declared' | 'run';

export function leaseIsExpired(lease: Pick<LeaseReading, 'expiresAt'>, now: number): boolean {
  return Date.parse(lease.expiresAt) <= now;
}

export type LeaseGrant<T> =
  | { status: 'unreadable' }
  | { status: 'held'; lease: T }
  | { status: 'set'; lease: T; expiresAt: number; kind: LeaseKind }
  | { status: 'taken'; expiresAt: number; kind: LeaseKind };

/**
 * Whether workspace `root` gets the device for `slot` at `now`, given the lease file (`null` when there is none,
 * `'unreadable'` when it holds something that is not a lease). Another workspace's or slot's unexpired lease is `held`.
 * This workspace's own unexpired lease is `set` to `now + durationMs`; a run on a lease the workspace `declared` never
 * shortens it, and the workspace keeps recording it as declared. A missing or expired lease is `taken` under `kind`.
 */
export function leaseGrant<T extends LeaseReading>({
  lease,
  root,
  slot,
  kind,
  declared,
  now,
  durationMs,
}: {
  lease: T | null | 'unreadable';
  root: string;
  slot: string;
  kind: LeaseKind;
  declared: boolean;
  now: number;
  durationMs: number;
}): LeaseGrant<T> {
  if (lease === 'unreadable') return { status: 'unreadable' };
  const asked = now + durationMs;
  if (!lease || leaseIsExpired(lease, now)) return { status: 'taken', expiresAt: asked, kind };
  if (lease.holder !== root || (lease.slot ?? 'default') !== slot) return { status: 'held', lease };
  return {
    status: 'set',
    lease,
    expiresAt: declared && kind === 'run' ? Math.max(asked, Date.parse(lease.expiresAt)) : asked,
    kind: declared ? 'declared' : kind,
  };
}

/** The leases `root` holds for `platform` and `slot` on devices other than `id`; taking `id` releases them. */
export function displacedLeases<T extends LeaseReading & { platform: string; id: string }>(
  leases: readonly (T | null)[],
  { root, platform, slot, id }: { root: string; platform: string; slot: string; id: string },
): T[] {
  return leases.filter(
    (lease): lease is T =>
      lease !== null &&
      lease.platform === platform &&
      lease.holder === root &&
      (lease.slot ?? 'default') === slot &&
      lease.id !== id,
  );
}

/**
 * Whether a run keeps its lease at least `minMs` past `now`: `lost` once the file no longer carries the run's `token`,
 * `kept` when it already runs that long, else `raised` to `now + minMs`.
 */
export function leaseRaise<T extends LeaseReading>(
  lease: T | null,
  token: string,
  now: number,
  minMs: number,
): { status: 'lost' } | { status: 'kept'; lease: T } | { status: 'raised'; lease: T; expiresAt: number } {
  if (!lease || lease.token !== token) return { status: 'lost' };
  const floor = now + minMs;
  return Date.parse(lease.expiresAt) >= floor
    ? { status: 'kept', lease }
    : { status: 'raised', lease, expiresAt: floor };
}
