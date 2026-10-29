import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DefaultArtifactClient } from '@actions/artifact';
import * as core from '@actions/core';
import { diagnosticArtifactFiles } from '@stim-cli/ci/artifacts';
import type { CIResult } from '@stim-cli/ci';

interface Inputs {
  platform: 'ios' | 'android' | 'macos' | 'web';
  project: string;
  command: string;
  version: string;
  cli: string;
  /** Empty when no result, test or diagnostic files were requested. */
  artifacts: string;
  exportPath: string;
  home: string;
  cache: string;
  timeout: string;
  upload: boolean;
  artifactName: string;
  retentionDays: number;
  selectors: string[];
  buildOnly: string[];
}

const SELECTOR_INPUTS = ['scheme', 'configuration', 'variant'] as const;
const BUILD_ONLY_INPUTS = ['arch', 'abi', 'eas-profile'] as const;

function flags(input: (name: string) => string, names: readonly string[]): string[] {
  return names.flatMap((name) => (input(name) ? [`--${name}`, input(name)] : []));
}

export function readInputs(input: (name: string) => string, root: string, host: string = process.platform): Inputs {
  if (host !== 'darwin' && host !== 'linux')
    throw new Error('Stim CI action supports macOS and Linux runners with Bash.');
  const platform = input('platform');
  if (platform !== 'ios' && platform !== 'android' && platform !== 'macos' && platform !== 'web') {
    throw new Error('platform must be ios, android, macos, or web.');
  }
  const command = input('command');
  if (!command.trim()) throw new Error('command is required.');
  const cli = input('cli-path');
  const version = input('version');
  if (!cli && !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/.test(version)) {
    throw new Error('version must be an exact published version when cli-path is absent.');
  }
  const timeout = input('timeout') || '1800';
  if (!/^\d+$/.test(timeout) || !Number.isSafeInteger(Number(timeout) * 1000) || Number(timeout) <= 0) {
    throw new Error('timeout must be a positive whole number of seconds.');
  }
  const upload = input('upload-artifacts') || 'true';
  if (upload !== 'true' && upload !== 'false') throw new Error('upload-artifacts must be true or false.');
  if (input('export') && platform === 'web')
    throw new Error('export does not apply to web projects, which have no native build.');
  const retention = input('retention-days') || '0';
  if (!/^\d+$/.test(retention) || !Number.isSafeInteger(Number(retention))) {
    throw new Error('retention-days must be a non-negative whole number.');
  }
  return {
    platform,
    project: resolve(root, input('project') || '.'),
    command,
    version,
    cli: cli ? resolve(root, cli) : '',
    artifacts: input('artifacts') ? resolve(root, input('artifacts')) : '',
    exportPath: input('export') ? resolve(root, input('export')) : '',
    home: input('home') ? resolve(root, input('home')) : '',
    cache: input('build-cache') ? resolve(root, input('build-cache')) : '',
    timeout,
    upload: upload === 'true' && Boolean(input('artifacts')),
    artifactName: input('artifact-name') || `stim-ci-${platform}-${randomUUID()}`,
    retentionDays: Number(retention),
    selectors: flags(input, SELECTOR_INPUTS),
    buildOnly: flags(input, BUILD_ONLY_INPUTS),
  };
}

async function execute(file: string, args: string[], cwd: string, stdout?: string[]): Promise<number> {
  const child = spawn(file, args, { cwd, stdio: ['inherit', stdout ? 'pipe' : 'inherit', 'inherit'] });
  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    stdout!.push(chunk.toString());
  });
  const interrupt = (): void => {
    child.kill('SIGINT');
  };
  const terminate = (): void => {
    child.kill('SIGTERM');
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    return await new Promise<number>((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => done(code ?? (signal === 'SIGINT' ? 130 : 143)));
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

function currentResult(path: string, options: Inputs, started: number): CIResult | null {
  try {
    if (!lstatSync(path).isFile()) throw new Error('result.json is not a regular file.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const result = JSON.parse(readFileSync(path, 'utf8')) as CIResult;
  if (
    result.version !== 1 ||
    result.platform !== options.platform ||
    typeof result.artifactsDir !== 'string' ||
    resolve(result.artifactsDir) !== options.artifacts ||
    typeof result.startedAt !== 'string' ||
    !(Date.parse(result.startedAt) >= started) ||
    !Number.isFinite(result.durationMs) ||
    !Number.isInteger(result.exitCode)
  )
    throw new Error('result.json does not describe this invocation; refusing stale artifacts.');
  return result;
}

export function finalResult(stdout: string[]): Record<string, unknown> | null {
  const lines = stdout.join('').trim().split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

function facts(result: Record<string, unknown> | null, stage: 'build' | 'run'): Record<string, unknown> {
  const section = result?.[stage] as { facts?: Record<string, unknown> } | null | undefined;
  return section?.facts ?? {};
}

export function setResultOutputs(
  build: Record<string, unknown> | null,
  run: Record<string, unknown> | null,
  setOutput: (name: string, value: string) => void,
): void {
  const built = facts(build, 'build');
  const ran = facts(run, 'run');
  const outputs: Record<string, unknown> = {
    'app-id': ran.bundleId ?? built.bundleId,
    'app-path': built.appPath ?? ran.appPath,
    'export-path': build?.artifactPath,
    'cache-hit': built.cacheHit,
    'device-id': ran.udid ?? ran.serial,
    'device-name': ran.deviceName,
  };
  for (const [name, value] of Object.entries(outputs)) {
    if (value !== undefined && value !== null && value !== '') setOutput(name, String(value));
  }
}

async function installCli(version: string, root: string): Promise<{ cli: string; code: number }> {
  const base = join(process.env.RUNNER_TOOL_CACHE ?? process.env.RUNNER_TEMP ?? tmpdir(), 'stim-ci-action', version);
  const cli = join(base, 'node_modules', '@stim-cli', 'ci', 'dist', 'stim-ci.mjs');
  if (existsSync(cli)) return { cli, code: 0 };
  const staging = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'stim-ci-install-'));
  try {
    const code = await execute(
      'npm',
      ['install', '--prefix', staging, '--ignore-scripts', '--no-audit', '--no-fund', `@stim-cli/ci@${version}`],
      root,
    );
    if (code !== 0) return { cli, code };
    mkdirSync(dirname(base), { recursive: true });
    try {
      renameSync(staging, base);
    } catch {
      if (!existsSync(cli)) {
        rmSync(base, { recursive: true, force: true });
        cpSync(staging, base, { recursive: true, verbatimSymlinks: true });
      }
    }
    return { cli, code: 0 };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function runAction(): Promise<number> {
  const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const options = readInputs((name) => core.getInput(name, { trimWhitespace: name !== 'command' }), root);
  let resultPath = '';
  if (options.artifacts) {
    mkdirSync(options.artifacts, { recursive: true });
    options.artifacts = realpathSync(options.artifacts);
    resultPath = join(options.artifacts, 'result.json');
    core.setOutput('result', resultPath);
    core.setOutput('artifacts', options.artifacts);
    if (readdirSync(options.artifacts).length) {
      throw new Error(`Artifacts directory must be empty: ${options.artifacts}. Choose a new directory for this run.`);
    }
  }
  let cli = options.cli;
  if (!cli) {
    const installed = await installCli(options.version, root);
    if (installed.code !== 0) return installed.code;
    cli = installed.cli;
  }
  const common = ['--platform', options.platform, '--project', options.project, '--timeout', options.timeout];
  if (options.home) common.push('--home', options.home);
  if (options.cache) common.push('--build-cache', options.cache);
  const buildOutput: string[] = [];
  let buildResult: Record<string, unknown> | null = null;
  const built = options.platform === 'ios' || options.platform === 'android' || Boolean(options.exportPath);
  if (built && options.platform !== 'web') {
    const buildArgs = [cli, 'build', ...common, ...options.selectors, ...options.buildOnly];
    if (options.exportPath) buildArgs.push('--export', options.exportPath);
    const buildCode = await execute(process.execPath, buildArgs, root, buildOutput);
    buildResult = finalResult(buildOutput);
    if (buildCode !== 0) {
      setResultOutputs(buildResult, null, core.setOutput);
      return buildCode;
    }
  }
  const args = [cli, 'run', ...common, ...options.selectors];
  if (options.artifacts) args.push('--artifacts', options.artifacts);
  args.push('--', 'bash', '-e', '-o', 'pipefail', '-c', options.command);
  const started = Date.now();
  const runOutput: string[] = [];
  let code = await execute(process.execPath, args, root, runOutput);
  setResultOutputs(buildResult, finalResult(runOutput), core.setOutput);
  core.setOutput('exit-code', String(code));
  let result: CIResult | null = null;
  if (options.artifacts) {
    try {
      result = currentResult(resultPath, options, started);
    } catch (error) {
      core.warning(String(error));
      return code || 1;
    }
  }
  if (options.upload) {
    try {
      const files = await diagnosticArtifactFiles(options.artifacts);
      if (!files.length) throw new Error('No diagnostic artifact files were produced.');
      const uploaded = await new DefaultArtifactClient().uploadArtifact(
        options.artifactName,
        files,
        options.artifacts,
        { retentionDays: options.retentionDays },
      );
      if (uploaded.id === undefined) throw new Error('GitHub did not return an artifact ID.');
      core.setOutput('artifact-id', uploaded.id);
      core.setOutput(
        'artifact-url',
        `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/artifacts/${uploaded.id}`,
      );
    } catch (error) {
      core.warning(`Diagnostic artifact upload failed: ${String(error)}`);
      code ||= 1;
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      core.summary.addHeading('Stim CI', 2).addTable([
        ['Platform', options.platform],
        ['Exit code', String(code)],
        ['Duration', result ? `${Math.round(result.durationMs / 1000)}s` : 'Result unavailable'],
      ]);
      await core.summary.write();
    } catch (error) {
      core.warning(`Could not write the job summary: ${String(error)}`);
    }
  }
  return code;
}
