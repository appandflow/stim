import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertExpoAgentCliInstall,
  expoAgentCliCommandAudit,
  expoAgentCliConfigViolations,
  expoAgentCliEnvironment,
  expoAgentCliInstallArguments,
} from './expo-agent-cli.mjs';

const audit = (...commands) => expoAgentCliCommandAudit(commands.map((command) => ({ command })));
const reasons = (...commands) => audit(...commands).violations.map((violation) => violation.reason);

describe('Expo agent CLI cloud audit', () => {
  it('accepts the local workflow', () => {
    expect(
      reasons('expo-agent-cli status', 'expo-agent-cli dev --ios --detach --local', 'expo-agent-cli smoke --ios'),
    ).toEqual([]);
  });

  it.each([
    ['expo-agent-cli dev --ios --eas', 'eas-flag'],
    ['cd app && expo-agent-cli smoke --eas', 'eas-flag'],
    ['expo-agent-cli deploy --native', 'cloud-command-deploy'],
    ['expo-agent-cli feedback --message hi', 'cloud-command-feedback'],
    ['expo-agent-cli --project x deploy', 'cloud-command-deploy'],
    ['expo-agent-cli --json dev --ios --eas', 'eas-flag'],
    ['expo-agent-cli deploy --native', 'cloud-command-deploy'],
    ['expo-agent-cli agents:setup', 'cloud-command-agents:setup'],
    ['expo-agent-cli agents setup', 'cloud-command-agents'],
    ['expo-agent-cli docs:sync', 'cloud-command-docs:sync'],
    ['expo-agent-cli docs sync', 'cloud-command-docs'],
    ['npx --yes eas-cli simulator:stop', 'eas-cli-invoked'],
    ['EXPO_TOKEN=abc expo-agent-cli status', 'expo-token-referenced'],
    ['npx @expo/agent-cli@latest status', 'package-run-through-package-runner'],
    ['npx -y @expo/agent-cli@1.0.99 status', 'package-run-through-package-runner'],
    ['npx --yes @expo/agent-cli@1.0.27 status', 'package-run-through-package-runner'],
    ['npx @expo/agent-cli status', 'package-run-through-package-runner'],
    ['bunx @expo/agent-cli status', 'package-run-through-package-runner'],
    ['pnpm dlx @expo/agent-cli@1.0.99 status', 'package-run-through-package-runner'],
    ['yarn dlx @expo/agent-cli status', 'package-run-through-package-runner'],
    ['node node_modules/@expo/agent-cli/bin/cli.js deploy', 'cloud-command-deploy'],
    ['node /x/node_modules/@expo/agent-cli/bin/cli.js dev --eas', 'eas-flag'],
  ])('rejects %s', (command, reason) => {
    expect(reasons(command)).toContain(reason);
  });

  it('counts a direct node run of the package as using the tool', () => {
    expect(audit('node /x/node_modules/@expo/agent-cli/bin/cli.js status').toolInvoked).toBe(true);
  });

  it('rejects project config that routes builds or devices to EAS', () => {
    expect(
      expoAgentCliConfigViolations({
        expo: { 'agent-cli': { target: 'dev-build', android: { buildBackend: 'eas' } } },
      }),
    ).toHaveLength(1);
    expect(expoAgentCliConfigViolations({ expo: { 'agent-cli': { target: 'dev-build' } } })).toEqual([]);
  });
});

describe('Expo agent CLI pinning', () => {
  const pins = { EXPO_AGENT_CLI_VERSION: '1.0.27', EXPO_AGENT_CLI_INTEGRITY: 'sha512-abc' };
  const lock = { packages: { 'node_modules/@expo/agent-cli': { integrity: 'sha512-abc' } } };

  it('refuses a floating or mismatched install', () => {
    expect(() => expoAgentCliInstallArguments({ prefix: '/p', version: 'latest' })).toThrow(/exact release/);
    expect(() =>
      assertExpoAgentCliInstall({ manifest: { name: '@expo/agent-cli', version: '1.0.28' }, lock, pins }),
    ).toThrow(/EXPO_AGENT_CLI_VERSION/);
    expect(() =>
      assertExpoAgentCliInstall({
        manifest: { name: '@expo/agent-cli', version: '1.0.27' },
        lock: { packages: { 'node_modules/@expo/agent-cli': { integrity: 'sha512-zzz' } } },
        pins,
      }),
    ).toThrow(/INTEGRITY/);
    expect(() =>
      assertExpoAgentCliInstall({ manifest: { name: '@expo/agent-cli', version: '1.0.27' }, lock, pins }),
    ).not.toThrow();
  });

  it('disables telemetry and drops the Expo token', () => {
    const environment = expoAgentCliEnvironment({ EXPO_TOKEN: 'x', PATH: '/bin', TMPDIR: '/run/tmp' });
    expect(environment).toEqual({
      EXPO_NO_TELEMETRY: '1',
      PATH: '/bin',
      TMPDIR: '/run/tmp',
      __UNSAFE_EXPO_HOME_DIRECTORY: join('/run/tmp', 'expo-home'),
    });
  });
});
