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

// Must run before a test can redirect HOME, so this captures the real root
// (see assertEasMachineRootWritable in eas-session-ledger.ts).
process.env[EAS_TEST_GUARD_ROOT_ENV] = join(homedir(), '.stim', 'machine', 'eas');
