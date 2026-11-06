import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./ci-darwin-unit-test-files.mjs', import.meta.url));
let root;
function write(file, text) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}
function selected() {
  execFileSync('git', ['add', '.'], { cwd: root });
  return execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\0')
    .filter(Boolean);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-ci-darwin-selection-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('selects tests gated by macOS platform, shell or filesystem behavior', () => {
  const files = {
    'packages/stim-cli/src/__tests__/platform.test.ts': "test.skipIf(process.platform !== 'darwin')('a', () => {});",
    'packages/stim-cli/src/__tests__/branch.test.ts':
      "const dir = process.platform === 'darwin' ? 'Library/Caches' : '.cache';",
    'packages/stim-cli/src/__tests__/shell.test.ts': "test.skipIf(!existsSync('/bin/zsh'))('a', () => {});",
    'packages/stim-cli/src/__tests__/filesystem.test.ts': "test.skipIf(!caseInsensitive)('a', () => {});",
  };
  for (const [file, source] of Object.entries(files)) write(file, source);
  expect(selected().toSorted()).toEqual(Object.keys(files).toSorted());
});

test('ignores tests that skip macOS or only simulate it', () => {
  write(
    'packages/stim-cli/src/__tests__/skipped.test.ts',
    "test.skipIf(process.platform === 'darwin')('a', () => {});",
  );
  write(
    'packages/stim-cli/src/__tests__/mocked.test.ts',
    "vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');",
  );
  expect(selected()).toEqual([]);
});

test('only unit test files the suite includes are selected', () => {
  const gate = "test.skipIf(process.platform !== 'darwin')('a', () => {});";
  const spaced = 'packages/server/__tests__/with spaces.test.ts';
  const benchmark = 'scripts/agent-benchmark/gated.test.mjs';
  write(spaced, gate);
  write(benchmark, gate);
  write('packages/stim-cli/src/__tests__/gated.compat.test.ts', gate);
  write('packages/server/__tests__/gated.browser.test.ts', gate);
  write('packages/stim-cli/src/__tests__/_helper.ts', gate);
  write('apps/mobile/src/gated.test.ts', gate);
  expect(selected()).toEqual([spaced]);
});
