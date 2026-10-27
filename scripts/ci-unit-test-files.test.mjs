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
  for (const file of [
    unit,
    'packages/stim-cli/src/engine/example.ts',
    'packages/stim-cli/src/__tests__/_fixture.ts',
    'README.md',
    'packages/stim-cli/src/__tests__/example.compat.test.ts',
  ])
    write(file, 'before');
  commit();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('modified existing root unit tests select every changed file, including spaces', () => {
  const spaced = 'packages/server/__tests__/with spaces.test.ts';
  write(spaced, 'before');
  commit();
  write(unit, 'after');
  write(spaced, 'after');
  commit();
  expect(selected()).toEqual([spaced, unit]);
  expect(selected('push')).toEqual([]);
});

test.each([
  'packages/stim-cli/src/engine/example.ts',
  'packages/stim-cli/src/__tests__/_fixture.ts',
  'README.md',
  'packages/stim-cli/src/__tests__/example.compat.test.ts',
])('changing %s alongside a unit test falls back to the full suite', (file) => {
  write(unit, 'after');
  write(file, 'after');
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

test('a missing base or empty diff falls back to the full suite', () => {
  expect(selected()).toEqual([]);
  git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'empty');
  expect(selected()).toEqual([]);
});
