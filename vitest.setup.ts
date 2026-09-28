import { homedir, tmpdir } from 'node:os';
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

// Keep gh from reaching GitHub with the developer's credentials: with an empty
// config dir and no token it exits 4 (signed out) without a network call.
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST']) {
  delete process.env[key];
}
process.env.GH_CONFIG_DIR = join(tmpdir(), 'stim-test-gh-config-absent');

// Stim records the agent session a command runs in and reads Codex's state from
// CODEX_HOME; a suite run from an agent's shell must not pick up either.
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CODEX_THREAD_ID;
delete process.env.CODEX_HOME;
