import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
const input = (name) => process.env[`STIM_ACTION_${name}`] ?? '';

async function execute(file, args) {
  const child = spawn(file, args, { cwd: root, stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    return await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => done(code ?? (signal === 'SIGINT' ? 130 : 143)));
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

async function main() {
  if (!input('COMMAND')) throw new Error('The command input is required.');
  if (!['ios', 'android', 'macos', 'web'].includes(input('PLATFORM')))
    throw new Error('The platform input must be ios, android, macos, or web.');
  let cli = input('CLI') ? resolve(root, input('CLI')) : null;
  if (!cli) {
    const version = input('VERSION');
    if (!/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/.test(version))
      throw new Error('Supply cli-path or an exact published @stim-cli/ci version.');
    const prefix = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'stim-ci-action-'));
    const installed = await execute('npm', [
      'install',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `@stim-cli/ci@${version}`,
    ]);
    if (installed !== 0) return installed;
    cli = join(prefix, 'node_modules', '@stim-cli', 'ci', 'dist', 'stim-ci.mjs');
  }
  const artifacts = resolve(root, input('ARTIFACTS') || 'stim-ci-results');
  const result = join(artifacts, 'result.json');
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `result=${result}\nartifacts=${artifacts}\n`);
  const args = [
    cli,
    'run',
    '--platform',
    input('PLATFORM'),
    '--project',
    resolve(root, input('PROJECT') || '.'),
    '--artifacts',
    artifacts,
    '--timeout',
    input('TIMEOUT') || '1800',
  ];
  if (input('HOME')) args.push('--home', resolve(root, input('HOME')));
  if (input('CACHE')) args.push('--build-cache', resolve(root, input('CACHE')));
  args.push('--', 'bash', '-e', '-o', 'pipefail', '-c', input('COMMAND'));
  const started = Date.now();
  const code = await execute(process.execPath, args);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      const summary = JSON.parse(readFileSync(result, 'utf8'));
      if (!(Date.parse(summary.startedAt) >= started)) throw new Error('Result belongs to an earlier run.');
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `Stim CI (${summary.platform}): exit ${summary.exitCode}; ${Math.round(summary.durationMs / 1000)}s.\n\nResults: \`${result}\`\n`,
      );
    } catch {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `Stim CI exited ${code} without a readable result.json for this run.\n`,
      );
    }
  }
  return code;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
