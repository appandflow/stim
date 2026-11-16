import { existsSync, lstatSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentCommand, AgentDriver, AgentRun, DriverOptions, TrialPaths } from '../types.ts';
import {
  asNumber,
  asRecord,
  asString,
  minimalPath,
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

function realAuth(): string {
  return join(process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex'), 'auth.json');
}

export const codexDriver: AgentDriver = {
  name: 'codex',
  expectedSkills: (withSkill) => (withSkill ? ['stim'] : []),
  prepare(paths: TrialPaths, skill: string | null): void {
    const auth = realAuth();
    if (!existsSync(auth)) throw new Error('Codex login not found; run codex login first.');
    symlinkSync(auth, join(paths.codexHome, 'auth.json'));
    writeFileSync(join(paths.home, '.zprofile'), `export PATH="${paths.bin}:$PATH"\n`);
    if (skill !== null) writeSkill(join(paths.codexHome, 'skills'), skill);
  },
  command(paths: TrialPaths, prompt: string, options: DriverOptions): AgentCommand {
    const config = [
      ...FEATURES_OFF.map((name) => `features.${name}=false`),
      'web_search="disabled"',
      'skills.bundled.enabled=false',
      'model_reasoning_effort="low"',
      'sandbox_workspace_write.exclude_slash_tmp=true',
      'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      `sandbox_workspace_write.writable_roots=[${JSON.stringify(paths.harness)}]`,
    ];
    return {
      command: options.bin ?? resolveBinary('codex'),
      args: [
        'exec',
        '--json',
        '--ephemeral',
        '--ignore-rules',
        '-s',
        'workspace-write',
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
  finish(paths: TrialPaths): void {
    const link = join(paths.codexHome, 'auth.json');
    if (lstatSync(link).isSymbolicLink()) return;
    const refreshed = readFileSync(link);
    const real = realAuth();
    const temp = `${real}.eval-${process.pid}`;
    writeFileSync(temp, refreshed, { mode: 0o600 });
    renameSync(temp, real);
  },
};
