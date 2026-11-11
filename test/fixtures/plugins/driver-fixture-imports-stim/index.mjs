import { runAgentDriverContract } from 'stim/plugin';

export const id = 'imports-stim';

export function createAgentDriver() {
  return { name: id, stop: () => void runAgentDriverContract };
}
