import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const cases = [
  { id: 'simulator', page: 'getting-started', title: 'Choose an iOS simulator' },
  { id: 'phone', page: 'getting-started', title: 'Run on a connected phone' },
  { id: 'logs', page: 'getting-started', title: 'Inspect recent errors' },
  { id: 'warm', page: 'getting-started', title: 'Work in parallel' },
  { id: 'slots', page: 'owned-devices', title: 'Test a change on multiple devices' },
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
  if (args.join(' ') === 'log -1 --oneline') return { output: '0000001 fix: update the example UI' };
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

export function commandState(id, workspace) {
  let guided = false;
  let started = false;
  let worktree = null;
  const slots = new Set();
  const trace = [];
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
      : {
          output: JSON.stringify({
            launched: true,
            bundleId: 'com.example.promptfixture',
            slot,
            device: { udid: `fixture-${slot}`, name: slot },
          }),
        };
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
      return { output: JSON.stringify({ ok: true, findings: [], project: { type: 'expo' }, warm: { ready: true } }) };
    }
    if (positional.length === 1 && positional[0] === 'start') {
      only(['--json']);
      started = true;
      return { output: JSON.stringify({ status: 'ready', port: 8083 }) };
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
      return { output: '[]' };
    }
    throw new Error(`Unexpected Stim action: ${args.join(' ')}`);
  }
  return { accept, trace };
}
