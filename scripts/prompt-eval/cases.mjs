import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const cases = [
  { id: 'simulator', page: 'getting-started', title: 'Choose an iOS simulator' },
  { id: 'phone', page: 'getting-started', title: 'Run on a connected phone' },
  { id: 'logs', page: 'getting-started', title: 'Inspect recent errors' },
  { id: 'warm', page: 'getting-started', title: 'Work in parallel' },
  { id: 'slots', page: 'owned-devices', title: 'Test a change on multiple devices' },
  { id: 'failure', page: 'getting-started', title: 'Build and run' },
  {
    id: 'stop',
    page: 'getting-started',
    title: 'Stop the environment',
    context: "This workspace's Stim dev server and iOS simulator are running from an earlier session.",
  },
];

export function websitePrompt(root, entry) {
  const source = readFileSync(resolve(root, `website/docs/${entry.page}.md`), 'utf8');
  const boxes = [...source.matchAll(/<PromptBox\b[\s\S]*?<\/PromptBox>/g)];
  const matches = boxes.filter(([box]) => box.includes(`title="${entry.title}"`));
  if (matches.length !== 1) throw new Error(`Expected one website prompt: ${entry.title}`);
  const body = matches[0][0].slice(matches[0][0].indexOf('>') + 1);
  const prompt = body.match(/\{`([^`]+)`\}/)?.[1];
  if (!prompt || prompt.includes('${')) throw new Error(`Unsupported prompt syntax: ${entry.title}`);
  return prompt;
}

function parseArguments(args) {
  const positional = [];
  const flags = new Map();
  const boolean = new Set(['--json', '--errors', '--device']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    if (flags.has(arg)) throw new Error(`Duplicate flag: ${arg}`);
    if (boolean.has(arg)) flags.set(arg, true);
    else {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error(`Missing flag value: ${arg}`);
      flags.set(arg, args[++i]);
    }
  }
  return { positional, flags };
}

function readGitFixture(args, workspace) {
  if (args[0] === 'show' && args.slice(1).every((arg) => ['--stat', '--oneline', 'HEAD'].includes(arg)))
    return { output: '0000001 fix: update the example UI\n App.tsx | 2 +-' };
  if (args[0] === 'diff' && args.slice(1).every((arg) => ['--stat', '--cached', '--name-only'].includes(arg)))
    return { output: '' };
  if (args[0] === 'log' && args.slice(1).every((arg) => ['-1', '--oneline', '--decorate', 'HEAD'].includes(arg)))
    return { output: '0000001 fix: update the example UI' };
  if (args.join(' ') === 'branch --show-current') return { output: 'main' };
  if (
    args[0] === 'status' &&
    args.slice(1).every((arg) => ['--short', '--branch', '--porcelain', '--porcelain=v1'].includes(arg))
  )
    return { output: args.includes('--branch') ? '## main' : '' };
  if (args.join(' ') === 'rev-parse --show-toplevel') return { output: workspace };
  if (args.join(' ') === 'worktree list' || args.join(' ') === 'worktree list --porcelain')
    return {
      output: `worktree ${workspace}\nHEAD 0000000000000000000000000000000000000001\nbranch refs/heads/main`,
    };
  return null;
}

const fingerprint = '6564e2a0c3b1f9d8e7a6b5c4d3e2f1a0b9c8d7e6';
const bundleId = 'com.example.promptfixture';
const launchFailure = 'STIM_LAUNCH_FAILED';

function fixturePaths(workspace) {
  const stimHome = resolve(workspace, '../stim-home');
  return { stimHome, logsDir: join(stimHome, 'workspaces/app--0123456789abcdef/logs') };
}

function doctorPayload(workspace, platform) {
  const installation = {
    path: '/usr/local/bin/stim',
    realPath: '/usr/local/lib/node_modules/stim/dist/cli.mjs',
    version: '1.8.0',
  };
  return {
    project: workspace,
    platform: platform ?? null,
    stim: {
      runningVersion: '1.8.0',
      runningPath: installation.realPath,
      resolved: installation,
      installations: [installation],
      versions: ['1.8.0'],
      highestVersion: '1.8.0',
      resolvedIsOlder: false,
    },
    findings: [],
  };
}

function startPayload(workspace) {
  return {
    port: 8083,
    supervisorPid: 48213,
    mode: 'expo-child',
    logsDir: fixturePaths(workspace).logsDir,
    alreadyRunning: false,
  };
}

function iosSlotPayload(workspace, slot, deviceType) {
  const { stimHome, logsDir } = fixturePaths(workspace);
  const physical = slot === 'hardware';
  const cacheKey = `${fingerprint}-debug-${physical ? 'device' : 'sim'}`;
  const model = deviceType ?? 'iPhone 17';
  return {
    platform: 'ios',
    slot,
    udid: physical
      ? '00008140-000A1C2E3F4B5D6E'
      : `F1E2D3C4-B5A6-4789-9ABC-0000000000${slot === 'phone' ? '01' : '02'}`,
    deviceName: physical ? "Example's iPhone" : `stim-app-${slot} (${model} 26.5)`,
    deviceType: physical ? null : model,
    runtime: physical ? null : '26.5',
    fingerprint,
    configuration: null,
    cacheKey,
    cacheHit: 'local',
    cacheSkipped: false,
    compilationCache: { status: 'not-run', hits: null, cacheableTasks: null, hitRatePercent: null },
    waitedForBuild: null,
    appPath: join(stimHome, 'build-cache', cacheKey, 'PromptFixture.app'),
    bundleId,
    installSkipped: false,
    launched: true,
    metroPort: 8083,
    logs: { dir: logsDir },
    durationMs: physical ? 38410 : 21870,
    ...(physical ? { lease: { kind: 'run', expiresAt: '2026-01-01T00:30:00.000Z' } } : {}),
  };
}

function launchFailurePayload(workspace) {
  return {
    code: launchFailure,
    message: 'The app failed its launch readiness check.',
    remedy: `Read the launch error above or run \`stim logs --errors\`. The full timeline is in ${fixturePaths(workspace).logsDir}.`,
  };
}

const launchErrorRecord = {
  ts: 1767225834210,
  src: 'metro',
  level: 'error',
  raw: true,
  msg: "ERROR  TypeError: Cannot read property 'title' of undefined\n\nThis error is located at:\n    in SettingsScreen (at App.tsx:12)",
};

function launchErrorLogs(json) {
  if (json) return JSON.stringify(launchErrorRecord);
  return [
    "14:03:54.210 error metro  ERROR  TypeError: Cannot read property 'title' of undefined",
    '    This error is located at:',
    '        in SettingsScreen (at App.tsx:12)',
  ].join('\n');
}

export function commandState(id, workspace) {
  let guided = false;
  let started = false;
  let worktree = null;
  let launchFailed = false;
  const diagnosed = new Set();
  const slots = new Set();
  const trace = [];
  function diagnose(step) {
    if (!launchFailed) return false;
    diagnosed.add(step);
    return diagnosed.size === 2;
  }
  function acceptSlot(flags) {
    const slot = flags.get('--slot');
    if (!['phone', 'tablet', 'hardware'].includes(slot) || slots.has(slot))
      throw new Error('Missing, repeated, or wrong slot');
    if ((slot === 'hardware') !== flags.has('--device')) throw new Error('Wrong physical-device slot');
    if (slot === 'tablet' && flags.get('--device-type') !== 'iPad Pro 13-inch (M5)')
      throw new Error('Tablet slot requires an iPad');
    if (slot === 'hardware' && (flags.has('--device-type') || flags.has('--runtime')))
      throw new Error('Unexpected hardware model selector');
    if (slot === 'phone' && flags.has('--device-type') && flags.get('--device-type') !== 'iPhone 17')
      throw new Error('Wrong phone model');
    if (flags.has('--runtime') && flags.get('--runtime') !== '26.5') throw new Error('Wrong slot runtime');
    slots.add(slot);
    return slots.size === 3
      ? { done: true }
      : { output: JSON.stringify(iosSlotPayload(workspace, slot, flags.get('--device-type'))) };
  }
  function acceptFailure(command, flags) {
    if (command === 'ios') {
      if (!started) throw new Error('Debug launch must follow start');
      if (launchFailed) throw new Error('Launch retried before reading the errors and the error guide');
      launchFailed = true;
      return { output: JSON.stringify(launchFailurePayload(workspace)), failed: true };
    }
    if (!launchFailed || !flags.has('--errors')) throw new Error('Expected logs --errors after the failed launch');
    return diagnose('logs') ? { done: true } : { output: launchErrorLogs(flags.has('--json')) };
  }
  function accept(command) {
    const { file, args, cwd } = command;
    if (
      typeof file !== 'string' ||
      !Array.isArray(args) ||
      !args.every((arg) => typeof arg === 'string') ||
      typeof cwd !== 'string'
    ) {
      throw new Error('Expected structured file, args, and absolute cwd');
    }
    trace.push(command);
    if (trace.length > 30) throw new Error('Command budget exceeded');
    if (cwd !== workspace && cwd !== worktree) throw new Error(`Wrong workspace: ${cwd}`);
    if (file === 'pwd' && !args.length) return { output: cwd };
    if (file === 'git') {
      const read = readGitFixture(args, workspace);
      if (read) return read;
    }
    if (file === 'git' && args[0] === 'worktree' && args[1] === 'add' && id === 'warm') {
      if (!guided || worktree) throw new Error('Worktree creation must follow the guide and occur once');
      const offset = args[2] === '-b' ? 4 : 2;
      if (
        !args[offset] ||
        args[offset].startsWith('-') ||
        args.length > offset + 2 ||
        (offset === 4 && (!args[3] || args[3].startsWith('-'))) ||
        args.slice(offset + 1).some((arg) => arg !== 'HEAD')
      )
        throw new Error('Unsupported worktree arguments');
      worktree = resolve(workspace, args[offset]);
      if (worktree === workspace) throw new Error('Worktree must be separate');
      return { output: 'Prepared isolated worktree.' };
    }
    if (file === 'agent-device' && id === 'slots' && slots.size > 0)
      return {
        output: JSON.stringify({
          exitCode: 127,
          stderr:
            'agent-device is unavailable in this simulated command-selection fixture; UI verification cannot be performed.',
        }),
      };
    if (file !== 'stim') throw new Error(`Unexpected command: ${file}`);
    if (args[0] === 'guide') {
      if (args.length < 2 || args.length > 3 || args.slice(1).some((arg) => !/^[a-zA-Z0-9_-]+$/.test(arg)))
        throw new Error('Invalid guide request');
      if (args[1] === 'agent' && args.length === 2) guided = true;
      if (id === 'failure' && args[1] === 'errors' && args[2] === launchFailure && diagnose('guide'))
        return { done: true };
      return { guide: args };
    }
    if (!guided) throw new Error('Stim action before loading guide agent');
    const { positional, flags } = parseArguments(args);
    function only(allowed) {
      if ([...flags.keys()].some((flag) => !allowed.includes(flag))) throw new Error('Unexpected command flags');
    }
    if (positional.length === 1 && positional[0] === 'doctor') {
      only(['--json', '--platform']);
      if (flags.has('--platform') && flags.get('--platform') !== 'ios') throw new Error('Wrong doctor platform');
      return { output: JSON.stringify(doctorPayload(workspace, flags.get('--platform'))) };
    }
    if (positional.length === 1 && positional[0] === 'start') {
      only(['--json']);
      started = true;
      return { output: JSON.stringify(startPayload(workspace)) };
    }
    if (positional.join(' ') === 'worktree warm' && id === 'warm') {
      only([]);
      if (!worktree || cwd !== worktree) throw new Error('Warm must run inside the new worktree');
      return { done: true };
    }
    if (positional.join(' ') === 'logs' && id === 'logs') {
      only(['--errors', '--since', '--json']);
      if (!flags.has('--errors') || flags.get('--since') !== '10m')
        throw new Error('Expected errors from the last 10 minutes');
      return { done: true };
    }
    if (id === 'failure' && ['ios', 'logs'].includes(positional.join(' '))) {
      only(positional[0] === 'ios' ? ['--json'] : ['--errors', '--since', '--json']);
      return acceptFailure(positional[0], flags);
    }
    if (positional.join(' ') === 'stop' && id === 'stop') {
      only(['--json']);
      return { done: true };
    }
    if (positional.join(' ') === 'ios' && ['simulator', 'phone', 'slots'].includes(id)) {
      only(['--device', '--device-type', '--runtime', '--slot', '--json']);
      if (!started) throw new Error('Debug launch must follow start');
      if (
        id === 'simulator' &&
        (flags.get('--device-type') !== 'iPhone 17' ||
          flags.get('--runtime') !== '26.5' ||
          flags.has('--device') ||
          flags.has('--slot'))
      )
        throw new Error('Wrong simulator selection');
      if (
        id === 'phone' &&
        (!flags.has('--device') || flags.has('--slot') || flags.has('--device-type') || flags.has('--runtime'))
      )
        throw new Error('Expected physical phone');
      if (id !== 'slots') return { done: true };
      return acceptSlot(flags);
    }
    if (positional.join(' ') === 'logs' && id === 'slots') {
      only(['--errors', '--slot', '--json']);
      if (!flags.has('--errors') || !slots.has(flags.get('--slot')))
        throw new Error('Errors must target an already launched slot');
      return {
        output: flags.has('--json') ? '' : `No matching log records in ${fixturePaths(workspace).logsDir}`,
      };
    }
    throw new Error(`Unexpected Stim action: ${args.join(' ')}`);
  }
  return { accept, trace };
}
