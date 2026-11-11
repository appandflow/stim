import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellCommandSegments } from './run-guards.mjs';

const EXPO_AGENT_CLI_PACKAGE = '@expo/agent-cli';
const EXPO_AGENT_CLI_BIN = 'expo-agent-cli';

// Commands documented in the 1.0.27 README of @expo/agent-cli (npm) that leave this machine:
// deploy ships to EAS Hosting (--native to EAS builds), feedback posts to Expo, and login/logout/register
// are passed through to the project's expo CLI and change an Expo account session.
// agents:setup writes into the user home and runs claude, npx or bunx; docs:sync fetches docs. Both belong to
// preparation, so a timed run rejects them.
const CLOUD_SUBCOMMANDS = new Set(['deploy', 'feedback', 'login', 'logout', 'register', 'agents', 'agents:setup']);
const EAS_CLI_NAMES = new Set(['eas', 'eas-cli']);
const BACKEND_KEYS = ['buildBackend', 'deviceBackend'];

export function expoAgentCliPrefix(root) {
  return join(root, 'expo-agent-cli');
}

export function expoAgentCliEnvironment(environment) {
  const clean = { ...environment, EXPO_NO_TELEMETRY: '1' };
  delete clean.EXPO_TOKEN;
  return clean;
}

export function expoAgentCliInstallArguments({ prefix, version }) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    throw new Error(`EXPO_AGENT_CLI_VERSION must be an exact release version, got ${version}`);
  }
  return [
    'install',
    '--prefix',
    prefix,
    '--save-exact',
    '--no-audit',
    '--no-fund',
    `${EXPO_AGENT_CLI_PACKAGE}@${version}`,
  ];
}

export function assertExpoAgentCliInstall({ manifest, lock, pins }) {
  const entry = lock?.packages?.[`node_modules/${EXPO_AGENT_CLI_PACKAGE}`];
  if (manifest?.name !== EXPO_AGENT_CLI_PACKAGE || manifest.version !== pins.EXPO_AGENT_CLI_VERSION) {
    throw new Error(
      `EXPO_AGENT_CLI_VERSION: expected ${pins.EXPO_AGENT_CLI_VERSION}, installed ${manifest?.version ?? 'nothing'}`,
    );
  }
  if (!entry?.integrity || entry.integrity !== pins.EXPO_AGENT_CLI_INTEGRITY) {
    throw new Error(
      `EXPO_AGENT_CLI_INTEGRITY: expected ${pins.EXPO_AGENT_CLI_INTEGRITY}, installed ${entry?.integrity ?? 'nothing'}`,
    );
  }
}

function expoAgentCliShim(prefix) {
  return `#!/bin/sh\nexec node ${JSON.stringify(join(prefix, 'node_modules', EXPO_AGENT_CLI_PACKAGE, 'bin', 'cli.js'))} "$@"\n`;
}

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

// Installs the pinned release into its own prefix, never into runtime/ where the Stim package and skill live.
export function installExpoAgentCli({ root, pins, run = execFileSync }) {
  const prefix = expoAgentCliPrefix(root);
  mkdirSync(prefix, { recursive: true });
  run('npm', expoAgentCliInstallArguments({ prefix, version: pins.EXPO_AGENT_CLI_VERSION }), {
    cwd: prefix,
    stdio: 'inherit',
    timeout: 10 * 60_000,
  });
  assertExpoAgentCliInstall({
    manifest: read(join(prefix, 'node_modules', EXPO_AGENT_CLI_PACKAGE, 'package.json')),
    lock: read(join(prefix, 'package-lock.json')),
    pins,
  });
  const binDirectory = join(prefix, 'bin');
  mkdirSync(binDirectory, { recursive: true });
  const shim = join(binDirectory, EXPO_AGENT_CLI_BIN);
  writeFileSync(shim, expoAgentCliShim(prefix));
  chmodSync(shim, 0o755);
  return { prefix, binDirectory, shim };
}

function words(segment) {
  return segment
    .split(/\s+/)
    .map((word) => word.replace(/^['"]+|['"]+$/g, ''))
    .filter(Boolean);
}

function toolInvocation(segmentWords) {
  const at = segmentWords.findIndex(
    (word) =>
      word === EXPO_AGENT_CLI_BIN ||
      word.split('/').at(-1) === EXPO_AGENT_CLI_BIN ||
      word.includes(EXPO_AGENT_CLI_PACKAGE),
  );
  return at === -1 ? null : { at, word: segmentWords[at] };
}

export function expoAgentCliCommandAudit(commands) {
  const violations = [];
  let toolInvoked = false;
  for (const { command } of commands) {
    const text = String(command ?? '');
    if (/\bEXPO_TOKEN\b/.test(text)) violations.push({ reason: 'expo-token-referenced', command: text });
    for (const segment of shellCommandSegments(text)) {
      const segmentWords = words(segment);
      const eas = segmentWords.findIndex((word) => EAS_CLI_NAMES.has(word.replace(/@.*$/, '')));
      if (eas !== -1) violations.push({ reason: 'eas-cli-invoked', command: segment });
      const tool = toolInvocation(segmentWords);
      if (!tool) continue;
      toolInvoked = true;
      const viaRunner =
        segmentWords.some((word) => word === 'npx' || word === 'bunx' || word === 'dlx') &&
        tool.word.startsWith(EXPO_AGENT_CLI_PACKAGE);
      if (viaRunner) violations.push({ reason: 'package-run-through-package-runner', command: segment });
      const args = segmentWords.slice(tool.at + 1);
      if (args.some((word) => word === '--eas' || word.startsWith('--eas='))) {
        violations.push({ reason: 'eas-flag', command: segment });
      }
      const positional = args.filter((word) => !word.startsWith('-'));
      for (const [index, word] of positional.entries()) {
        const spaced = word === 'docs' && positional[index + 1] === 'sync';
        if (CLOUD_SUBCOMMANDS.has(word) || word === 'docs:sync' || spaced) {
          violations.push({ reason: `cloud-command-${word}`, command: segment });
        }
      }
    }
  }
  return { violations, toolInvoked };
}

export function expoAgentCliConfigViolations(packageJson) {
  const config = packageJson?.expo?.['agent-cli'];
  if (!config || typeof config !== 'object') return [];
  const violations = [];
  for (const scope of [config, config.ios, config.android]) {
    for (const key of BACKEND_KEYS) {
      if (scope?.[key] === 'eas') violations.push(`expo.agent-cli ${key} is "eas"`);
    }
  }
  return violations;
}

function directoryDigest(directory) {
  const hash = createHash('sha256');
  const visit = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path, `${prefix}${entry.name}/`);
      else if (entry.isFile()) hash.update(`${prefix}${entry.name}\0`).update(readFileSync(path)).update('\0');
    }
  };
  visit(directory, '');
  return hash.digest('hex');
}

export function checkExpoAgentCliPreparation({ root, pins, skillsRoot, projectManifest }) {
  const prefix = expoAgentCliPrefix(root);
  assertExpoAgentCliInstall({
    manifest: read(join(prefix, 'node_modules', EXPO_AGENT_CLI_PACKAGE, 'package.json')),
    lock: read(join(prefix, 'package-lock.json')),
    pins,
  });
  if (!skillsRoot || directoryDigest(skillsRoot) !== pins.EXPO_SKILLS_SHA256) {
    throw new Error('EXPO_SKILLS_SHA256: the Expo skills directory does not match the pin');
  }
  const config = expoAgentCliConfigViolations(projectManifest);
  if (config.length) throw new Error(`fixture routes work to EAS: ${config.join('; ')}`);
  return { prefix };
}
