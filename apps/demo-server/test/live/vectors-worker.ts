import { workerDh } from '../../src/demo.ts';
import { runSharedVectors } from '../vectors.ts';

export default {
  fetch: (): Response => Response.json(runSharedVectors(workerDh, { framing: true })),
};
