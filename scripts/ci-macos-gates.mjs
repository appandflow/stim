import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const shared = [
  /^package\.json$/,
  /^pnpm-[^/]+$/,
  /^\.github\/actions\/setup-stim\//,
  /^\.github\/workflows\/ci\.yml$/,
  /^scripts\/ci-macos-gates\./,
];

const nativeProcessInspection = [
  ...shared,
  /^packages\/core\//,
  /^tsconfig\.base\.json$/,
  /^test\/e2e\/native-(?:processes|cleanup)\.e2e\.js$/,
  /^test\/e2e\/native\/(?:harness|assertions)\.mjs$/,
];

const macosUnit = [
  ...shared,
  /^packages\//,
  /^scripts\/agent-benchmark\//,
  /^scripts\/ci-darwin-unit-test-files/,
  /^test\//,
  /^(?:vitest|tsconfig|knip)[^/]*$/,
];

const matches = (patterns, file) => patterns.some((pattern) => pattern.test(file));

export function selectGates(files) {
  return {
    macosUnit: files === null || files.some((file) => matches(macosUnit, file)),
    nativeProcessInspection: files === null || files.some((file) => matches(nativeProcessInspection, file)),
  };
}

const zeros = /^0+$/;

function changedFiles(
  env,
  git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
) {
  let range;
  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    range = ['HEAD^1', 'HEAD'];
  } else if (env.GITHUB_EVENT_NAME === 'push' && env.BEFORE_SHA && !zeros.test(env.BEFORE_SHA)) {
    git(['fetch', '--no-tags', '--depth=1', 'origin', env.BEFORE_SHA]);
    range = [env.BEFORE_SHA, 'HEAD'];
  } else {
    return null;
  }
  return git(['diff', '--name-only', '--no-renames', '-z', ...range])
    .split('\0')
    .filter(Boolean);
}

export function outputs(env, git) {
  let files = null;
  try {
    files = changedFiles(env, git);
  } catch (error) {
    console.error(`Could not list changed files (${error.message}); running every macOS job.`);
  }
  const gates = selectGates(files);
  console.error(files === null ? 'Changed files: unknown' : `Changed files: ${files.length}`);
  const os = gates.nativeProcessInspection ? ['macos-15', 'windows-latest'] : ['windows-latest'];
  return [
    `macos_unit=${gates.macosUnit}`,
    `native_process_inspection=${gates.nativeProcessInspection}`,
    `native_process_inspection_os=${JSON.stringify(os)}`,
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lines = outputs(process.env);
  console.error(lines.join('\n'));
  process.stdout.write(`${lines.join('\n')}\n`);
}
