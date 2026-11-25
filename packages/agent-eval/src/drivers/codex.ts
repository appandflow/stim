import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { secretValues } from '../redact.ts';
import { requireConfined } from '../roots.ts';
import type { AgentCommand, AgentDriver, AgentRun, DriverOptions, TrialPaths } from '../types.ts';
import {
  asNumber,
  asArray,
  asRecord,
  asString,
  minimalPath,
  readablePaths,
  parseLines,
  resolveBinary,
  unwrapShell,
  writeSkill,
} from './shared.ts';

const FEATURES_OFF = [
  'apps',
  'plugins',
  'remote_plugin',
  'tool_suggest',
  'multi_agent',
  'browser_use',
  'computer_use',
  'image_generation',
  'hooks',
];

export function parseCodex(transcript: string): AgentRun {
  const run: AgentRun = {
    commands: [],
    edits: [],
    skills: [],
    turns: null,
    tokens: { input: 0, output: 0, cached: 0 },
    costUsd: null,
    finalMessage: '',
    isolation: null,
    error: 'the transcript has no turn.completed event',
  };
  let steps = 0;
  let completed = false;
  for (const event of parseLines(transcript)) {
    if (event.type === 'item.completed') {
      const item = asRecord(event.item);
      if (item.type === 'command_execution') {
        steps += 1;
        const command = unwrapShell(asString(item.command));
        const output = asString(item.aggregated_output);
        run.commands.push({
          command,
          denied: item.status === 'declined' || output.includes('Operation not permitted'),
        });
        const skill = /skills\/([\w-]+)\/SKILL\.md/.exec(command);
        if (skill?.[1]) run.skills.push(skill[1]);
      } else if (item.type === 'file_change' && item.status === 'completed') {
        for (const change of asArray(item.changes).map(asRecord))
          run.edits.push({ path: asString(change.path), after: run.commands.length });
      } else if (item.type === 'agent_message') {
        run.finalMessage = asString(item.text);
        steps += 1;
      }
    } else if (event.type === 'turn.completed') {
      completed = true;
      const usage = asRecord(event.usage);
      run.tokens.input += asNumber(usage.input_tokens);
      run.tokens.output += asNumber(usage.output_tokens);
      run.tokens.cached = (run.tokens.cached ?? 0) + asNumber(usage.cached_input_tokens);
      run.error = null;
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      run.error = `codex reported ${asString(event.type)}: ${asString(asRecord(event.error).message) || asString(event.message)}`;
    }
  }
  run.turns = completed ? steps : null;
  return run;
}

function realAuth(paths: TrialPaths): string {
  return join(paths.roots.codexHome, 'auth.json');
}

interface LoginState {
  target: string;
  secrets: string[];
}

const LOGINS = new WeakMap<TrialPaths, LoginState>();

function permissionProfile(paths: TrialPaths): string {
  const access: Record<string, string> = {
    ':minimal': 'read',
    ':workspace_roots': 'write',
    [paths.harness]: 'write',
    [paths.bin]: 'read',
    [paths.home]: 'read',
    [join(paths.base, 'repo', '.git')]: 'read',
    [join(paths.codexHome, 'skills')]: 'read',
    ...Object.fromEntries(readablePaths().map((path) => [path, 'read'])),
    '/tmp': 'deny',
    '/private/tmp': 'deny',
  };
  return `{ ${Object.entries(access)
    .map(([path, mode]) => `${JSON.stringify(path)} = ${JSON.stringify(mode)}`)
    .join(', ')} }`;
}

export const codexDriver: AgentDriver = {
  name: 'codex',
  expectedSkills: (withSkill) => (withSkill ? ['stim'] : []),
  prepare(paths: TrialPaths, skill: string | null): void {
    const auth = realAuth(paths);
    if (!existsSync(auth)) throw new Error('Codex login not found; run codex login first.');
    const target = requireConfined(auth, paths.roots.home, 'the Codex login', readablePaths());
    LOGINS.set(paths, { target, secrets: secretValues(readFileSync(target, 'utf8')) });
    symlinkSync(target, join(paths.codexHome, 'auth.json'));
    writeFileSync(join(paths.home, '.zprofile'), `export PATH="${paths.bin}:$PATH"\n`);
    if (skill !== null) writeSkill(join(paths.codexHome, 'skills'), skill);
  },
  command(paths: TrialPaths, prompt: string, options: DriverOptions): AgentCommand {
    const config = [
      ...FEATURES_OFF.map((name) => `features.${name}=false`),
      'web_search="disabled"',
      'skills.bundled.enabled=false',
      'model_reasoning_effort="low"',
      'default_permissions="eval"',
      `permissions.eval.filesystem=${permissionProfile(paths)}`,
    ];
    return {
      command: options.bin ?? resolveBinary('codex'),
      args: [
        'exec',
        '--json',
        '--ephemeral',
        '--ignore-rules',
        '-C',
        paths.workspace,
        ...(options.model ? ['-m', options.model] : []),
        ...config.flatMap((value) => ['-c', value]),
        prompt,
      ],
      env: {
        HOME: paths.home,
        CODEX_HOME: paths.codexHome,
        USER: process.env.USER ?? '',
        LANG: 'en_US.UTF-8',
        TERM: 'dumb',
        PATH: minimalPath(paths),
        STIM_HOME: paths.stimHome,
      },
    };
  },
  parse: parseCodex,
  secrets: (paths) => LOGINS.get(paths)?.secrets ?? [],
  finish(paths: TrialPaths): string | null {
    const state = LOGINS.get(paths);
    const link = join(paths.codexHome, 'auth.json');
    const kind = lstatSync(link, { throwIfNoEntry: false });
    if (!state || !kind || kind.isSymbolicLink()) return null;
    const moved = join(dirname(state.target), `auth.json.eval-${Date.now()}`);
    writeFileSync(moved, readFileSync(link), { mode: 0o600, flag: 'wx' });
    rmSync(link);
    return `Codex replaced the login link with its own file during the trial; it was moved to ${moved} and the real login was not touched. codex login may be needed`;
  },
};
