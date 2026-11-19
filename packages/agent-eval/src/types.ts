type OutputSource = 'real' | 'synthetic';

export interface ScriptRule {
  argv: string[];
  prefix?: boolean;
  cwd?: string;
  stdout?: string;
  stderr?: string;
  exit?: number;
  source: OutputSource;
  note: string;
}

type InvocationKind = 'guide' | 'scripted' | 'unscripted' | 'blanked';

export interface Invocation {
  argv: string[];
  cwd: string;
  cwdRelative: string;
  kind: InvocationKind;
  startedAt: number;
  endedAt: number;
  exitCode: number;
  stdoutBytes: number;
  stderrBytes: number;
  path: string;
  self: string;
  homeReadable?: boolean;
}

export interface StimEvalConfig {
  rules: ScriptRule[];
  blank: string[][];
  log: string;
  workspace: string;
  guideCli: string;
  guideHome: string;
  probe: string;
}

export interface AttemptedCommand {
  command: string;
  denied: boolean;
}

export interface FileEdit {
  path: string;
  after: number;
}

export interface AgentRun {
  commands: AttemptedCommand[];
  edits: FileEdit[];
  skills: string[];
  turns: number | null;
  tokens: { input: number; output: number; cached: number | null };
  costUsd: number | null;
  finalMessage: string;
  isolation: { skills: string[]; mcpServers: string[]; plugins: string[] } | null;
  error: string | null;
}

export interface Roots {
  home: string;
  claudeProjects: string;
  claudeTmp: string;
  codexHome: string;
}

export interface TrialPaths {
  roots: Roots;
  base: string;
  workspace: string;
  bin: string;
  harness: string;
  stimHome: string;
  home: string;
  codexHome: string;
}

export interface AgentCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface DriverOptions {
  model: string | null;
  bin: string | null;
}

export interface AgentDriver {
  name: 'claude' | 'codex';
  expectedSkills(withSkill: boolean): string[];
  prepare(paths: TrialPaths, skill: string | null): void;
  secrets(paths: TrialPaths): string[];
  command(paths: TrialPaths, prompt: string, options: DriverOptions): AgentCommand;
  parse(transcript: string): AgentRun;
  finish(paths: TrialPaths): string | null;
}

export interface GradeInput {
  invocations: Invocation[];
  run: AgentRun;
}

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
  observation?: boolean;
  inconclusive?: boolean;
}

export interface EvalCase {
  id: string;
  prompt: string;
  workspace: { files: Record<string, string> };
  script: ScriptRule[];
  grade(input: GradeInput): Check[];
}
