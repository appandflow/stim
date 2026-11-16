import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { secretValues } from '../redact.ts';
import { REPO_ROOT } from '../trial.ts';
import type { AgentCommand, AgentDriver, AgentRun, DriverOptions, FinishContext, TrialPaths } from '../types.ts';
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

interface LoginState {
  target: string;
  digest: string;
  secrets: string[];
}

const LOGINS = new WeakMap<TrialPaths, LoginState>();
const SYSTEM_READS = [
  '/usr',
  '/bin',
  '/sbin',
  '/System',
  '/Library',
  '/private/etc',
  '/dev',
  '/opt/homebrew',
  '/Applications/Xcode.app',
];

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function permissionProfile(paths: TrialPaths): string {
  const access: Record<string, string> = {
    ':minimal': 'read',
    ':workspace_roots': 'write',
    [paths.harness]: 'write',
    [paths.bin]: 'read',
    [paths.home]: 'read',
    [join(paths.codexHome, 'skills')]: 'read',
    [dirname(dirname(process.execPath))]: 'read',
    [REPO_ROOT]: 'read',
    ...Object.fromEntries(SYSTEM_READS.map((path) => [path, 'read'])),
    '/tmp': 'deny',
    '/private/tmp': 'deny',
  };
  return `{ ${Object.entries(access)
    .map(([path, mode]) => `${JSON.stringify(path)} = ${JSON.stringify(mode)}`)
    .join(', ')} }`;
}

function quarantine(paths: TrialPaths, refreshed: Buffer, directory: string, reasons: string[]): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const copy = join(directory, `auth-${basename(paths.base)}.json`);
  writeFileSync(copy, refreshed, { mode: 0o600 });
  return `the Codex login may need codex login again: ${reasons.join('; ')}. The refreshed copy is at ${copy}; the real auth.json was not touched`;
}

function writeBack(target: string, refreshed: Buffer): void {
  const temp = join(dirname(target), `.auth.json.eval-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    writeFileSync(temp, refreshed, { mode: 0o600, flag: 'wx' });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

export const codexDriver: AgentDriver = {
  name: 'codex',
  expectedSkills: (withSkill) => (withSkill ? ['stim'] : []),
  prepare(paths: TrialPaths, skill: string | null): void {
    const auth = realAuth();
    if (!existsSync(auth)) throw new Error('Codex login not found; run codex login first.');
    const target = realpathSync(auth);
    const content = readFileSync(target);
    LOGINS.set(paths, { target, digest: digest(content), secrets: secretValues(content.toString('utf8')) });
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
  finish(paths: TrialPaths, context: FinishContext): string | null {
    const state = LOGINS.get(paths);
    const link = join(paths.codexHome, 'auth.json');
    const kind = lstatSync(link, { throwIfNoEntry: false });
    if (!state || !kind || kind.isSymbolicLink()) return null;
    const refreshed = readFileSync(link);
    if (digest(refreshed) === state.digest) return null;
    const reasons: string[] = [];
    if (context.killed) reasons.push('the run was killed by a timeout or a signal');
    try {
      JSON.parse(refreshed.toString('utf8'));
    } catch {
      reasons.push('the refreshed file is not valid JSON');
    }
    try {
      if (digest(readFileSync(state.target)) !== state.digest)
        reasons.push('the real auth.json changed during the trial');
    } catch {
      reasons.push('the real auth.json cannot be read');
    }
    if (reasons.length === 0) {
      try {
        writeBack(state.target, refreshed);
        return null;
      } catch (error) {
        reasons.push(`writing the real auth.json failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return quarantine(paths, refreshed, context.quarantineDir, reasons);
  },
};
