import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.HOST_RELEASE_CHECK_ROOT ?? join(import.meta.dirname, '..');
const sources = 'packages/server/host';
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
const fail = (message) => {
  process.stderr.write(`host-release-check: ${message}\n`);
  process.exit(1);
};

const pin = /const RELEASE: HostRelease \| null = \{\s*version: '([^']+)'/.exec(
  readFileSync(join(root, 'packages/server/src/stim-host.ts'), 'utf8'),
)?.[1];
if (!pin) fail('cannot read the pinned Stim Host version from RELEASE in packages/server/src/stim-host.ts.');
const tag = `host-v${pin}`;
try {
  git('rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`);
} catch {
  fail(`the pinned Stim Host ${pin} has no ${tag} tag here. Run \`git fetch --tags\` and retry.`);
}
const changed = git('diff', '--name-only', tag, 'HEAD', '--', sources);
if (changed) {
  fail(
    `${sources} changed since ${tag}, which the pinned Stim Host was built from:\n${changed}\n` +
      'Cut a new Stim Host release and pin it (RELEASE.md, "Stim Host releases") before this release.',
  );
}
process.stdout.write(`host-release-check: ${sources} matches ${tag}\n`);
