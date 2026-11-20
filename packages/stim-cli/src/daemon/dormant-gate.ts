const HOLDER = 0;
const STEP_STARTED = 1;
const FREE = 0n;
const LADDER = 1n;
const STEP = 2n;

/**
 * The turn the stimd tick and the passes thread share: free, held by a ladder pass for disk, or held by the lane's
 * dormant step, with when that step took it.
 */
export function createDormantGate(): BigInt64Array {
  return new BigInt64Array(new SharedArrayBuffer(2 * BigInt64Array.BYTES_PER_ELEMENT));
}

/** Takes the turn for the lane's dormant step, at any level, while no ladder pass holds it. */
export function admitStep(gate: BigInt64Array, now: number = Date.now()): boolean {
  if (Atomics.compareExchange(gate, HOLDER, FREE, STEP) !== FREE) return false;
  Atomics.store(gate, STEP_STARTED, BigInt(now));
  return true;
}

export function releaseStep(gate: BigInt64Array): void {
  Atomics.compareExchange(gate, HOLDER, STEP, FREE);
}

/** How long the lane's dormant step has held the turn; 0 when it does not hold it. */
export function stepHeldMs(gate: BigInt64Array, now: number = Date.now()): number {
  return Atomics.load(gate, HOLDER) === STEP ? now - Number(Atomics.load(gate, STEP_STARTED)) : 0;
}

/** Takes the turn for a ladder pass; false while the lane's dormant step holds it. */
export function holdLadder(gate: BigInt64Array): boolean {
  return Atomics.compareExchange(gate, HOLDER, FREE, LADDER) === FREE;
}

/** Takes the turn for a ladder pass once the lane that held it has settled. */
export function takeLadder(gate: BigInt64Array): void {
  Atomics.store(gate, HOLDER, LADDER);
}

export function releaseLadder(gate: BigInt64Array): void {
  Atomics.store(gate, HOLDER, FREE);
}
