const HOLDER = 0;
const DISK = 1;
const FREE = 0;
const LADDER = 1;
const STEP = 2;

/**
 * The turn the stimd tick and the passes thread share for the dormant step: who holds it (free, the tick's disk ladder
 * pass, or the lane's dormant step) and the disk level the tick last measured, 0 for normal.
 */
export function createDormantGate(): Int32Array {
  return new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
}

/** Records the disk level the tick measured, from 0 for normal to 2 for critical. */
export function noteDiskLevel(gate: Int32Array, rank: number): void {
  Atomics.store(gate, DISK, rank);
}

/** Takes the turn for the lane's dormant step: only while the disk is at normal and no ladder pass holds it. */
export function admitStep(gate: Int32Array): boolean {
  return Atomics.load(gate, DISK) === 0 && Atomics.compareExchange(gate, HOLDER, FREE, STEP) === FREE;
}

export function releaseStep(gate: Int32Array): void {
  Atomics.compareExchange(gate, HOLDER, STEP, FREE);
}

/** Takes the turn for a disk ladder pass; false while the lane's dormant step holds it. */
export function holdLadder(gate: Int32Array): boolean {
  return Atomics.compareExchange(gate, HOLDER, FREE, LADDER) === FREE;
}

/** Takes the turn for a ladder pass once the lane that held it has settled. */
export function takeLadder(gate: Int32Array): void {
  Atomics.store(gate, HOLDER, LADDER);
}

export function releaseLadder(gate: Int32Array): void {
  Atomics.store(gate, HOLDER, FREE);
}
