import { mkdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { TEMP_LEFTOVERS_TEST_GUARD_ENV } from './packages/stim-cli/src/commands/gc/temp-leftovers-guard-env.ts';

// The machine running the suite may legitimately export STIM_* overrides
// (this machine relocates the shared caches to an external SSD via
// ~/.zshenv). Tests assert the DEFAULT layout and set their own overrides,
// so ambient ones must not leak in.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('STIM_')) delete process.env[key];
}

process.env.STIM_DAEMON = 'off';
// A test never reads or writes this machine's engine store or its bin/stimd shim.
process.env.STIM_ENGINE_ROOT = join(tmpdir(), 'stim-test-engine-absent');

// A test never reads or writes the developer's home: ~/.stim/machine (the EAS ledger, the list of Stim homes) and
// every other HOME-derived path resolve under the run's private TMPDIR (vitest.global-tmpdir.ts).
// npm keeps its package cache under HOME; the tests that pack and install Stim run offline and need the real one.
process.env.npm_config_cache ??= join(homedir(), '.npm');
const home = join(tmpdir(), 'home');
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;

// gc never sweeps the real TMPDIR from a test, even one that mocks the STIM_HOME scope away.
process.env[TEMP_LEFTOVERS_TEST_GUARD_ENV] = realpathSync(tmpdir());

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

// Stim reads the Ruby environment of the login shell named by SHELL; a test must not run the developer's shell.
delete process.env.SHELL;

// @expo/fingerprint runs `npx react-native config` in a project without expo-modules-autolinking 1.12 or later, and
// npx installs react-native (about 330 MB) from the registry when the project has none. Offline, npx fails at once.
process.env.npm_config_offline ??= 'true';

beforeEach(({ task }) => {
  if (/\.(?:integration|compat)\.test\.(?:ts|mjs)$/.test(task.file.filepath)) return;
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'hrtime'],
  });
});

afterEach(() => vi.useRealTimers());
