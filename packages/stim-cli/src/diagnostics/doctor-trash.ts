import { daemonNdjsonFile } from '@stim-cli/core/state';
import { itemTrashInventory } from '../workspace/item-trash.ts';
import type { Finding } from './doctor.ts';

export async function trashHealthFindings(now: number, signal?: AbortSignal): Promise<Finding[]> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 3_000);
  const reading = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    const { oldest, complete } = await itemTrashInventory(reading);
    signal?.throwIfAborted();
    if (!oldest || now - Date.parse(oldest.createdAt) <= 24 * 60 * 60_000) return [];
    return [
      {
        code: 'gc-trash-stale',
        level: 'note',
        title: 'Pending cleanup trash is over 24 hours old',
        detail: `${oldest.path} was queued at ${oldest.createdAt}. Its payload is still present; pending bytes remain estimates.${complete ? '' : ' Other entries could not all be checked.'}`,
        fix: `Read ${daemonNdjsonFile()} for failed trash drains, then run stim doctor again.`,
      },
    ];
  } catch {
    signal?.throwIfAborted();
    return [];
  } finally {
    clearTimeout(timer);
  }
}
