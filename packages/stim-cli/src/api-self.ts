import { createLocalStim } from './api/client.ts';
import type { StimClient, StimOptions } from './api/types.ts';

/**
 * `createStim` for code that runs inside this build, such as stim-server and `stim ci`: every operation runs this
 * build, never the machine engine's.
 */
export function createStim(options: StimOptions): StimClient {
  return createLocalStim(options);
}
