import { parseArgs } from 'node:util';
import { runCI, type CIOptions } from './index.ts';

declare const STIM_CI_VERSION: string;

const HELP = `Usage: stim-ci run --platform <ios|android|macos|web> [options] -- <command> [args...]

Build and launch an app, run a test command, collect diagnostics, and stop it.
The final result is JSON on stdout; progress and test output go to stderr.

Options:
  --project <path>       Project directory (default: current directory)
  --artifacts <path>     Results directory (default: a fresh temporary directory)
  --home <path>          Explicit Stim home (default: job-local on GitHub-hosted runners)
  --build-cache <path>   Native artifact cache directory
  --timeout <seconds>   Setup and test timeout (cleanup has its own deadline)
  --help                Show this help
  --version             Show the package version
`;

function parse(argv: string[]): CIOptions {
  const separator = argv.indexOf('--');
  if (separator < 0) throw new Error('Separate the test command with --.');
  const command = argv.slice(separator + 1);
  if (!command[0]) throw new Error('A test command is required after --.');
  const { values, positionals } = parseArgs({
    args: argv.slice(0, separator),
    allowPositionals: true,
    options: {
      platform: { type: 'string' },
      project: { type: 'string' },
      artifacts: { type: 'string' },
      home: { type: 'string' },
      'build-cache': { type: 'string' },
      timeout: { type: 'string' },
    },
  });
  if (positionals.length !== 1 || positionals[0] !== 'run') throw new Error('Expected stim-ci run.');
  const platform = values.platform;
  if (platform !== 'ios' && platform !== 'android' && platform !== 'macos' && platform !== 'web') {
    throw new Error('--platform must be ios, android, macos or web.');
  }
  const timeoutMs = values.timeout === undefined ? undefined : Number(values.timeout) * 1000;
  return {
    projectRoot: values.project ?? process.cwd(),
    run: { platform },
    command: command as [string, ...string[]],
    artifactsDir: values.artifacts,
    home: values.home,
    buildCache: values['build-cache'],
    timeoutMs,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && argv[0] === '--version') {
    process.stdout.write(`${STIM_CI_VERSION}\n`);
    return;
  }
  if (argv.length === 0 || argv[0] === '--help' || (argv[0] === 'run' && argv[1] === '--help')) {
    process.stdout.write(HELP);
    return;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  try {
    const options = parse(argv);
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    const result = await runCI({
      ...options,
      signal: controller.signal,
      onProgress: ({ message }) => process.stderr.write(message),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`stim-ci: ${(error as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
