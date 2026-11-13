import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isUnitTestFile } from './ci-unit-test-pattern.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export function planChecks(files, base, platform, exists = () => true) {
  if (base && !files.length) return [];
  const checks = [['pnpm', 'run', 'format:check']];
  const pnpm = (...args) => checks.push(['pnpm', ...args]);
  const code = files.filter((file) => !/\.(?:md|mdx)$/.test(file));
  const touches = (prefix) => code.some((file) => file.startsWith(prefix));
  const scoped =
    /^(?:packages\/|scripts\/|\.github\/actions\/stim-ci\/|apps\/(?:desktop|mobile|demo-server)\/|website\/)/;
  const shared =
    /(?:^|\/)(?:package\.json|[jt]sconfig[^/]*\.json|[^/]*\.config\.[^/]+|[Ff]ixtures\/|[^/]*-fixture[s]?\.[^/]+$)/;
  const broad = !base || code.some((file) => !scoped.test(file) || shared.test(file) || !exists(file));
  const testFiles = [
    ...new Set(
      code.flatMap((file) => {
        if (isUnitTestFile(file)) return [file];
        if (!file.startsWith('scripts/') || !file.endsWith('.mjs')) return [];
        const test = file.replace(/\.mjs$/, '.test.mjs');
        return isUnitTestFile(test) && exists(test) ? [test] : [];
      }),
    ),
  ];
  const rootSource = code.some(
    (file) => !isUnitTestFile(file) && /^(?:packages\/|scripts\/|\.github\/actions\/stim-ci\/|website\/)/.test(file),
  );
  const appChecks = broad || touches('packages/core/') || touches('scripts/ratchet') || touches('scripts/oxlint/');
  const mobile = appChecks || touches('apps/mobile/');
  const demo = appChecks || touches('apps/demo-server/') || code.includes('apps/mobile/mock-server/payloads.mjs');

  if (broad || rootSource || testFiles.length) pnpm('run', 'lint');
  if (broad || rootSource || testFiles.length || mobile || demo) pnpm('run', 'build');
  if (broad || rootSource) pnpm('run', 'typecheck');
  if (broad || touches('packages/core/') || touches('packages/server/') || touches('apps/mobile/src/protocol/')) {
    pnpm('run', 'rpc:check');
  }
  for (const [stage, integration] of [
    ['test:unit', false],
    ['test:integration', true],
  ]) {
    const direct = testFiles.filter((file) => file.includes('.integration.test.') === integration);
    if (broad) pnpm('run', stage);
    else {
      if (rootSource) pnpm('run', stage, '--changed', base, '--passWithNoTests');
      if (direct.length) pnpm('run', stage, ...direct.map((file) => `./${file}`));
    }
  }
  const benchmarkInputs = [
    'scripts/agent-benchmark/',
    'scripts/launch-crash-benchmark.mjs',
    'test/e2e/native/fixtures/xcode/',
    'website/src/data/benchmark-matrix.json',
    'packages/stim-cli/src/engine/eas-machine-root-guard-env.ts',
    'packages/stim-cli/src/commands/gc/temp-leftovers-guard-env.ts',
  ];
  if (broad || benchmarkInputs.some(touches)) pnpm('run', 'test:bench');
  if (mobile) {
    for (const script of ['format:check', 'lint', 'typecheck', 'test']) {
      pnpm('--filter', 'stim-mobile', 'run', script);
    }
  }
  if (demo) {
    pnpm('--filter', 'stim-demo-server', 'run', 'typecheck');
    pnpm('--filter', 'stim-demo-server', 'test');
  }
  if (broad || files.some((file) => file.startsWith('website/'))) pnpm('--filter', 'website', 'run', 'build');
  if (platform === 'darwin' && (broad || touches('apps/desktop/'))) {
    checks.push(['apps/desktop/scripts/format.sh', '--check']);
  }
  return checks;
}

function changes(ref) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const commit = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
  const base = git('merge-base', 'HEAD', commit).trim();
  const diff = ['diff', '--name-only', '-z', '--no-renames'];
  const paths = [
    git(...diff, base, 'HEAD'),
    git(...diff, '--cached'),
    git(...diff),
    git('ls-files', '--others', '--exclude-standard', '-z'),
  ];
  return { base, files: [...new Set(paths.join('').split('\0').filter(Boolean))].toSorted() };
}

function run() {
  const { values } = parseArgs({
    options: { base: { type: 'string', default: 'origin/main' }, 'dry-run': { type: 'boolean' } },
  });
  let scope;
  try {
    scope = changes(values.base);
  } catch {
    console.error('Could not compare with the base. Selecting the full local checks.');
    scope = { files: [], base: null };
  }
  const checks = planChecks(scope.files, scope.base, process.platform, (file) => existsSync(join(root, file)));
  if (!checks.length) console.log('No changed files to check.');
  else console.log('Also run any additional regressions and platform checks required by AGENTS.md.');
  for (const command of checks)
    console.log(command.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' '));
  if (values['dry-run']) return;
  for (const [command, ...args] of checks) {
    if (command === 'pnpm' && process.platform === 'win32') {
      const pnpm = process.env.npm_execpath;
      if (!pnpm) throw new Error('Run this command with pnpm check:changed.');
      if (/\.exe$/i.test(pnpm)) execFileSync(pnpm, args, { cwd: root, stdio: 'inherit' });
      else execFileSync(process.execPath, [pnpm, ...args], { cwd: root, stdio: 'inherit' });
    } else {
      execFileSync(command, args, { cwd: root, stdio: 'inherit' });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (error) {
    if (typeof error.status !== 'number') console.error(error.message);
    process.exitCode = error.status || 1;
  }
}
