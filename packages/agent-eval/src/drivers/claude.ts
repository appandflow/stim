import { existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AgentCommand, AgentDriver, AgentRun, AttemptedCommand, DriverOptions, TrialPaths } from '../types.ts';
import { asArray, asNumber, asRecord, asString, minimalPath, parseLines, writeSkill } from './shared.ts';

const TOOLS = 'Bash,Read,Glob,Grep,Skill';
const ALLOWED = [
  'Bash(stim:*)',
  'Bash(npx stim:*)',
  'Bash(cd:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(pwd)',
  'Bash(git status:*)',
  'Bash(git worktree list:*)',
  'Skill',
  'Read',
  'Glob',
  'Grep',
];
const BUILT_IN_SKILLS = ['design', 'doctor'];

export function parseClaude(transcript: string): AgentRun {
  const run: AgentRun = {
    commands: [],
    skills: [],
    turns: null,
    tokens: { input: 0, output: 0, cached: null },
    costUsd: null,
    finalMessage: '',
    isolation: null,
    error: 'the transcript has no result event',
  };
  const byId = new Map<string, AttemptedCommand>();
  let lastText = '';
  for (const event of parseLines(transcript)) {
    if (event.type === 'system' && event.subtype === 'init') {
      run.isolation = {
        skills: asArray(event.skills).map(asString),
        mcpServers: asArray(event.mcp_servers).map((server) => asString(asRecord(server).name)),
        plugins: asArray(event.plugins)
          .map(asRecord)
          .filter((plugin) => plugin.path !== 'builtin')
          .map((plugin) => asString(plugin.name)),
      };
    } else if (event.type === 'assistant') {
      for (const block of asArray(asRecord(event.message).content).map(asRecord)) {
        if (block.type === 'text') lastText = asString(block.text);
        if (block.type !== 'tool_use') continue;
        const input = asRecord(block.input);
        if (block.name === 'Bash') {
          const attempt = { command: asString(input.command), denied: false };
          run.commands.push(attempt);
          byId.set(asString(block.id), attempt);
        } else if (block.name === 'Skill') run.skills.push(asString(input.skill));
      }
    } else if (event.type === 'user') {
      for (const block of asArray(asRecord(event.message).content).map(asRecord)) {
        const attempt = byId.get(asString(block.tool_use_id));
        if (attempt && block.is_error === true && /permission|denied|not allowed/i.test(JSON.stringify(block.content)))
          attempt.denied = true;
      }
    } else if (event.type === 'result') {
      const usage = asRecord(event.usage);
      const cacheRead = asNumber(usage.cache_read_input_tokens);
      run.turns = asNumber(event.num_turns);
      run.costUsd = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null;
      run.tokens = {
        input: asNumber(usage.input_tokens) + asNumber(usage.cache_creation_input_tokens) + cacheRead,
        output: asNumber(usage.output_tokens),
        cached: cacheRead,
      };
      run.finalMessage = typeof event.result === 'string' ? event.result : lastText;
      run.error =
        event.is_error === true || event.subtype !== 'success' ? `claude ended with ${asString(event.subtype)}` : null;
    }
  }
  return run;
}

export const claudeDriver: AgentDriver = {
  name: 'claude',
  expectedSkills: (withSkill) => (withSkill ? ['stim', ...BUILT_IN_SKILLS] : BUILT_IN_SKILLS),
  prepare(paths: TrialPaths, skill: string | null): void {
    if (skill !== null) writeSkill(join(paths.workspace, '.claude', 'skills'), skill);
  },
  command(paths: TrialPaths, prompt: string, options: DriverOptions): AgentCommand {
    const home = process.env.HOME ?? '';
    return {
      command: options.bin ?? join(home, '.local', 'bin', 'claude'),
      args: [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        options.model ?? 'haiku',
        '--no-session-persistence',
        '--setting-sources',
        'project',
        '--strict-mcp-config',
        '--tools',
        TOOLS,
        '--permission-mode',
        'dontAsk',
        '--allowedTools',
        ...ALLOWED,
        '--max-budget-usd',
        '1',
      ],
      env: {
        HOME: home,
        USER: process.env.USER ?? '',
        LOGNAME: process.env.USER ?? '',
        SHELL: '/bin/bash',
        LANG: 'en_US.UTF-8',
        TERM: 'dumb',
        PATH: minimalPath(paths),
        STIM_HOME: paths.stimHome,
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
      },
    };
  },
  parse: parseClaude,
  finish(paths: TrialPaths): void {
    const trial = basename(paths.base);
    for (const root of [
      join(process.env.HOME ?? '', '.claude', 'projects'),
      `/tmp/claude-${process.getuid?.() ?? ''}`,
    ]) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root))
        if (entry.includes(trial) && entry.endsWith('-workspace'))
          rmSync(join(root, entry), { recursive: true, force: true });
    }
  },
};
