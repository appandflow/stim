import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root;
const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
const check = () =>
  spawnSync(process.execPath, [join(import.meta.dirname, 'host-release-check.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, HOST_RELEASE_CHECK_ROOT: root },
  });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-host-release-check-'));
  mkdirSync(join(root, 'packages/server/src'), { recursive: true });
  mkdirSync(join(root, 'packages/server/host'), { recursive: true });
  writeFileSync(
    join(root, 'packages/server/src/stim-host.ts'),
    "const RELEASE: HostRelease | null = {\n  version: '0.2.0',\n  sha256: 'x',\n};\n",
  );
  writeFileSync(join(root, 'packages/server/host/stim-host-helper.c'), 'int main(void) { return 0; }\n');
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'host');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('passes while the Host sources match the pinned tag and fails once they change', () => {
  git('tag', 'host-v0.2.0');
  writeFileSync(join(root, 'README.md'), 'other\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'other');
  expect(check().status).toBe(0);
  writeFileSync(join(root, 'packages/server/host/stim-host-helper.c'), 'int main(void) { return 1; }\n');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', 'helper');
  const changed = check();
  expect(changed.status).toBe(1);
  expect(changed.stderr).toContain('packages/server/host/stim-host-helper.c');
});

test('fails with a fetch hint when the pinned tag is missing', () => {
  const missing = check();
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('git fetch --tags');
});
