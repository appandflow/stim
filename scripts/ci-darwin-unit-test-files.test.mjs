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

test.each([
  ["test.skipIf(process.platform !== 'darwin')('a', () => {});", true],
  ["if (process.platform !== 'darwin') return;", true],
  ["const dir = process.platform === 'darwin' ? 'Library/Caches' : '.cache';", true],
  ["test.skipIf(!existsSync('/bin/zsh'))('a', () => {});", true],
  ["test.skipIf(!caseInsensitive)('a', () => {});", true],
  ["test.skipIf(process.platform === 'darwin')('a', () => {});", false],
  ["vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');", false],
  ["runDoctor(project, { host: 'darwin' });", false],
  ["test.skipIf(process.platform === 'win32')('a', () => {});", false],
])('%s selects the file: %s', (source, expected) => {
  const file = 'packages/stim-cli/src/__tests__/gated.test.ts';
  write(file, source);
  expect(selected()).toEqual(expected ? [file] : []);
});

test('only unit test files the suite includes are selected', () => {
  const gate = "test.skipIf(process.platform !== 'darwin')('a', () => {});";
  const spaced = 'packages/server/__tests__/with spaces.test.ts';
  const benchmark = 'scripts/agent-benchmark/gated.test.mjs';
  write(spaced, gate);
  write(benchmark, gate);
  write('packages/stim-cli/src/__tests__/gated.compat.test.ts', gate);
  write('packages/stim-cli/src/__tests__/_helper.ts', gate);
  write('apps/mobile/src/gated.test.ts', gate);
  expect(selected().toSorted()).toEqual([spaced, benchmark].toSorted());
});
