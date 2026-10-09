import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DefaultArtifactClient } from '@actions/artifact';
import * as core from '@actions/core';
import { buildArtifactFiles, diagnosticArtifactFiles } from '@stim-cli/ci/artifacts';
import type { CIBuildResult, CIResult } from '@stim-cli/ci';

interface Inputs {
  stage: 'build' | 'run';
  platform: 'ios' | 'android' | 'macos' | 'web';
  project: string;
  command: string;
  version: string;
  cli: string;
  artifacts: string;
  home: string;
  cache: string;
  timeout: string;
  upload: boolean;
  artifactName: string;
  retentionDays: number;
}

export function readInputs(input: (name: string) => string, root: string, host: string = process.platform): Inputs {
  if (host !== 'darwin' && host !== 'linux')
    throw new Error('Stim CI action supports macOS and Linux runners with Bash.');
  const platform = input('platform');
  if (platform !== 'ios' && platform !== 'android' && platform !== 'macos' && platform !== 'web') {
    throw new Error('platform must be ios, android, macos, or web.');
  }
  const stage = input('stage') || 'run';
  if (stage !== 'build' && stage !== 'run') throw new Error('stage must be build or run.');
  if (stage === 'build' && platform === 'web') throw new Error('Web has no native build artifact. Use stage: run.');
  const command = input('command');
  if (stage === 'run' && !command.trim()) throw new Error('command is required for stage: run.');
  if (stage === 'build' && command.trim()) throw new Error('command only applies to stage: run.');
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
  const retention = input('retention-days') || '0';
  if (!/^\d+$/.test(retention) || !Number.isSafeInteger(Number(retention))) {
    throw new Error('retention-days must be a non-negative whole number.');
  }
  return {
    stage,
    platform,
    project: resolve(root, input('project') || '.'),
    command,
    version,
    cli: cli ? resolve(root, cli) : '',
    artifacts: resolve(root, input('artifacts') || `stim-ci-${stage}-results`),
    home: input('home') ? resolve(root, input('home')) : '',
    cache: input('build-cache') ? resolve(root, input('build-cache')) : '',
    timeout,
    upload: upload === 'true',
    artifactName: input('artifact-name') || `stim-ci-${stage}-${platform}-${randomUUID()}`,
    retentionDays: Number(retention),
  };
}

async function execute(file: string, args: string[], cwd: string): Promise<number> {
  const child = spawn(file, args, { cwd, stdio: 'inherit' });
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

function currentResult(path: string, options: Inputs, started: number): CIResult | CIBuildResult | null {
  try {
    if (!lstatSync(path).isFile()) throw new Error('result.json is not a regular file.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const result = JSON.parse(readFileSync(path, 'utf8')) as CIResult | CIBuildResult;
  if (
    result.version !== 1 ||
    ('stage' in result ? result.stage : 'run') !== options.stage ||
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

export async function runAction(): Promise<number> {
  const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const options = readInputs((name) => core.getInput(name, { trimWhitespace: name !== 'command' }), root);
  mkdirSync(options.artifacts, { recursive: true });
  options.artifacts = realpathSync(options.artifacts);
  const resultPath = join(options.artifacts, 'result.json');
  core.setOutput('result', resultPath);
  core.setOutput('artifacts', options.artifacts);
  if (readdirSync(options.artifacts).length) {
    throw new Error(`Artifacts directory must be empty: ${options.artifacts}. Choose a new directory for this run.`);
  }
  let installation: string | undefined;
  try {
    let cli = options.cli;
    if (!cli) {
      installation = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'stim-ci-action-'));
      const code = await execute(
        'npm',
        [
          'install',
          '--prefix',
          installation,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          `@stim-cli/ci@${options.version}`,
        ],
        root,
      );
      if (code !== 0) return code;
      cli = join(installation, 'node_modules', '@stim-cli', 'ci', 'dist', 'stim-ci.mjs');
    }
    const args = [
      cli,
      options.stage,
      '--platform',
      options.platform,
      '--project',
      options.project,
      '--artifacts',
      options.artifacts,
      '--timeout',
      options.timeout,
    ];
    if (options.home) args.push('--home', options.home);
    if (options.cache) args.push('--build-cache', options.cache);
    if (options.stage === 'run') args.push('--', 'bash', '-e', '-o', 'pipefail', '-c', options.command);
    const started = Date.now();
    let code = await execute(process.execPath, args, root);
    let result: CIResult | CIBuildResult | null;
    try {
      result = currentResult(resultPath, options, started);
    } catch (error) {
      core.warning(String(error));
      return code || 1;
    }
    const build = result && 'stage' in result && result.stage === 'build' ? result : null;
    if (build?.artifactPath) core.setOutput('build-artifact', build.artifactPath);
    if (options.upload) {
      try {
        const files =
          options.stage === 'build'
            ? await buildArtifactFiles(options.artifacts, build?.artifactPath ?? null)
            : await diagnosticArtifactFiles(options.artifacts);
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
          ['Stage', options.stage],
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
  } finally {
    if (installation) rmSync(installation, { recursive: true, force: true });
  }
}
