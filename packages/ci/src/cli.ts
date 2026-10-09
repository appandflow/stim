import { parseArgs } from 'node:util';
import { buildCI, runCI, type CIBuildOptions, type CIOptions } from './index.ts';

declare const STIM_CI_VERSION: string;

const HELP = `Usage: stim-ci build --platform <ios|android|macos> [options]
       stim-ci run --platform <ios|android|macos|web> [options] -- <command> [args...]

Build exports an artifact without starting or stopping an app.
Run builds and launches an app, runs a test command, collects diagnostics, and stops it.
The final result is JSON on stdout; progress and test output go to stderr.

Options:
  --project <path>       Project directory (default: current directory)
  --artifacts <path>     Results directory (default: a fresh temporary directory)
  --home <path>          Explicit Stim home (default: job-local on GitHub-hosted runners)
  --build-cache <path>   Native artifact cache directory
  --timeout <seconds>   Setup and test timeout (cleanup has its own deadline)
  --scheme <name>       iOS build scheme
  --configuration <name> iOS build configuration
  --variant <name>      Android build variant
  --arch <name>         Build-only iOS architecture: arm64, x86_64, all
  --abi <name>          Build-only Android ABI: arm64-v8a, armeabi-v7a, x86, x86_64, all
  --help                Show this help
  --version             Show the package version
`;

type Invocation = { stage: 'run'; options: CIOptions } | { stage: 'build'; options: CIBuildOptions };

function parse(argv: string[]): Invocation {
  const separator = argv.indexOf('--');
  const command = separator < 0 ? [] : argv.slice(separator + 1);
  const { values, positionals } = parseArgs({
    args: separator < 0 ? argv : argv.slice(0, separator),
    allowPositionals: true,
    options: {
      platform: { type: 'string' },
      project: { type: 'string' },
      artifacts: { type: 'string' },
      home: { type: 'string' },
      'build-cache': { type: 'string' },
      timeout: { type: 'string' },
      scheme: { type: 'string' },
      configuration: { type: 'string' },
      variant: { type: 'string' },
      arch: { type: 'string' },
      abi: { type: 'string' },
    },
  });
  const stage = positionals[0];
  if (positionals.length !== 1 || (stage !== 'run' && stage !== 'build'))
    throw new Error('Expected stim-ci build or run.');
  const platform = values.platform;
  if (platform !== 'ios' && platform !== 'android' && platform !== 'macos' && platform !== 'web') {
    throw new Error('--platform must be ios, android, macos or web.');
  }
  const timeoutMs = values.timeout === undefined ? undefined : Number(values.timeout) * 1000;
  const common = {
    projectRoot: values.project ?? process.cwd(),
    artifactsDir: values.artifacts,
    home: values.home,
    buildCache: values['build-cache'],
    timeoutMs,
  };
  if (
    platform !== 'ios' &&
    (values.scheme !== undefined || values.configuration !== undefined || values.arch !== undefined)
  )
    throw new Error('--scheme, --configuration and --arch only apply to iOS.');
  if (platform !== 'android' && (values.variant !== undefined || values.abi !== undefined))
    throw new Error('--variant and --abi only apply to Android.');
  if (stage === 'build') {
    if (separator >= 0) throw new Error('Build-only does not take a test command. Use stim-ci run to launch and test.');
    if (platform === 'web')
      throw new Error('Web projects have no native build artifact. Use stim-ci run --platform web.');
    if (values.arch !== undefined && !['arm64', 'x86_64', 'all'].includes(values.arch))
      throw new Error('--arch must be arm64, x86_64 or all.');
    if (values.abi !== undefined && !['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64', 'all'].includes(values.abi))
      throw new Error('--abi must be arm64-v8a, armeabi-v7a, x86, x86_64 or all.');
    const build: CIBuildOptions['build'] =
      platform === 'ios'
        ? {
            platform,
            scheme: values.scheme,
            configuration: values.configuration,
            arch: values.arch as 'arm64' | 'x86_64' | 'all' | undefined,
          }
        : platform === 'android'
          ? {
              platform,
              variant: values.variant,
              abi: values.abi as 'arm64-v8a' | 'armeabi-v7a' | 'x86' | 'x86_64' | 'all' | undefined,
            }
          : { platform };
    return { stage, options: { ...common, build } };
  }
  if (values.arch !== undefined || values.abi !== undefined)
    throw new Error('--arch and --abi only apply to build-only.');
  if (separator < 0) throw new Error('Separate the test command with --.');
  if (!command[0]) throw new Error('A test command is required after --.');
  const run: CIOptions['run'] =
    platform === 'ios'
      ? { platform, scheme: values.scheme, configuration: values.configuration }
      : platform === 'android'
        ? { platform, variant: values.variant }
        : { platform };
  return { stage, options: { ...common, run, command: command as [string, ...string[]] } };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && argv[0] === '--version') {
    process.stdout.write(`${STIM_CI_VERSION}\n`);
    return;
  }
  if (
    argv.length === 0 ||
    argv[0] === '--help' ||
    ((argv[0] === 'run' || argv[0] === 'build') && argv[1] === '--help')
  ) {
    process.stdout.write(HELP);
    return;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  try {
    const invocation = parse(argv);
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    const callbacks = {
      signal: controller.signal,
      onProgress: ({ message }: { message: string }) => {
        process.stderr.write(message);
      },
    };
    const result =
      invocation.stage === 'build'
        ? await buildCI({ ...invocation.options, ...callbacks })
        : await runCI({ ...invocation.options, ...callbacks });
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
