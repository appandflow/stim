import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireTestSlot } from './scripts/test-slot.mjs';

const DEFAULT_SLOTS = 2;

function slotDirectory(): string {
  const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return join(process.platform === 'win32' ? tmpdir() : '/tmp', `stim-test-slots-${user}`);
}

export default async function setup(): Promise<() => void> {
  if (process.env.CI || process.env.STIM_TEST_RUN) return () => {};
  const configured = Number(process.env.STIM_TEST_SLOTS ?? DEFAULT_SLOTS);
  const slots = Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_SLOTS;
  return acquireTestSlot({
    dir: slotDirectory(),
    slots,
    details: { cwd: process.cwd() },
    log: (line) => process.stderr.write(`${line}\n`),
  });
}
