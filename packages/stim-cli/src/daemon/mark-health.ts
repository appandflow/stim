import type { GcMark, GcMarkHealth, GcStaleMarkEvidence, Config, DaemonMode } from '@stim-cli/core/state';
import type { StimContext } from '@stim-cli/core';
import { candidateInventory } from './candidate-inventory.ts';
    holders: batch.marks.flatMap(({ root, device, markedAt }) => {
      const scope = holders.get(root);
      return scope ? [{ root, device, markedAt, ...scope }] : [];
    }),
  };
}
