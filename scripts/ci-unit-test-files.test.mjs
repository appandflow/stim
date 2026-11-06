import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./ci-unit-test-files.mjs', import.meta.url));
const unit = 'packages/stim-cli/src/__tests__/example.test.ts';
let root;
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
function write(file, text) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}
function commit() {
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
}
function selected(event = 'pull_request') {
  return execFileSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: event },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\0')
    .filter(Boolean);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-ci-selection-'));
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  mkdirSync(join(root, 'hooks'));
  git('config', 'core.hooksPath', join(root, 'hooks'));
  for (const file of [unit, 'packages/stim-cli/src/engine/example.ts']) write(file, 'before');
  commit();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('modified existing root unit tests select every changed file, including spaces', () => {
  const files = [
    '.github/actions/stim-ci/src/example.test.ts',
    'packages/server/__tests__/with spaces.test.ts',
    unit,
    'scripts/example.test.mjs',
    'website/scripts/example.test.mjs',
    'website/src/example.test.ts',
  ];
  for (const file of files) write(file, 'before');
  commit();
  for (const file of files) write(file, 'after');
  commit();
  expect(selected()).toEqual(files);
  expect(selected('push')).toEqual([]);
});

test('changing production code alongside a unit test falls back to the full suite', () => {
  write(unit, 'after');
  write('packages/stim-cli/src/engine/example.ts', 'after');
  commit();
  expect(selected()).toEqual([]);
});

test('adding or removing a test falls back to the full suite', () => {
  const added = 'packages/server/__tests__/added.test.ts';
  write(added, 'before');
  commit();
  expect(selected()).toEqual([]);
  rmSync(join(root, added));
  commit();
  expect(selected()).toEqual([]);
});
