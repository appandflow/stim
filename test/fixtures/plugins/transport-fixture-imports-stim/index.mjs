import { runTransportContract } from 'stim/plugin';

export const id = 'imports-stim';

export function createTransport() {
  return { id, close: () => void runTransportContract };
}
