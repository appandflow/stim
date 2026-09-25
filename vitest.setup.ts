import { homedir } from 'node:os';
import { join } from 'node:path';
import { EAS_TEST_GUARD_ROOT_ENV } from './packages/stim-cli/src/engine/eas-machine-root-guard-env.ts';

// The machine running the suite may legitimately export STIM_* overrides
// (this machine relocates the shared caches to an external SSD via
// ~/.zshenv). Tests assert the DEFAULT layout and set their own overrides,
// so ambient ones must not leak in.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('STIM_')) delete process.env[key];
}

// The EAS session ledger and project lock ignore STIM_HOME and read the real
// ~/.stim/machine/eas, so a test that forgets to redirect ledgerRoot,
// machineRoot, easLedgerRoot, or HOME (and USERPROFILE on Windows) would
// write there. Recording the real root here, before any test in this process
// can override HOME, lets those writers refuse a write whose resolved root
// still matches it (see assertEasMachineRootWritable). A write by a process
// without this marker, such as a real stim run, is unaffected.
process.env[EAS_TEST_GUARD_ROOT_ENV] = join(homedir(), '.stim', 'machine', 'eas');
