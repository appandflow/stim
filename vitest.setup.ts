import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The machine running the suite may legitimately export STIM_* overrides
// (this machine relocates the shared caches to an external SSD via
// ~/.zshenv). Tests assert the DEFAULT layout and set their own overrides,
// so ambient ones must not leak in.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('STIM_')) delete process.env[key];
}

const realEasMachineRoot = join(homedir(), '.stim', 'machine', 'eas');

function realEasMachineSnapshot(): string {
  try {
    return readdirSync(realEasMachineRoot)
      .toSorted()
      .map((entry) => {
        const stat = statSync(join(realEasMachineRoot, entry));
        return `${entry}:${stat.mtimeMs}:${stat.size}`;
      })
      .join('\n');
  } catch {
    return '';
  }
}

const realEasMachineBefore = realEasMachineSnapshot();

afterAll(() => {
  if (realEasMachineSnapshot() !== realEasMachineBefore) {
    throw new Error(
      `${realEasMachineRoot} changed while this file ran. The EAS ledger and project lock ignore STIM_HOME, so a test must pass a temporary ledgerRoot, machineRoot, or easLedgerRoot. A real stim run on this machine at the same time also trips this check.`,
    );
  }
});
