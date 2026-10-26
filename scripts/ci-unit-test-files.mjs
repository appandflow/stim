import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';

let files = [];
if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
  try {
    const changed = execFileSync('git', ['diff', '--name-status', '-z', 'HEAD^1', 'HEAD'], { encoding: 'utf8' });
    const entries = changed.split('\0').slice(0, -1);
    const unit =
      /^(?:packages\/[^/]+\/(?:src\/|__tests__\/).+\.test\.ts|scripts\/.+\.test\.mjs|website\/scripts\/.+\.test\.mjs|website\/src\/.+\.test\.ts|\.github\/actions\/stim-ci\/src\/.+\.test\.ts)$/;
    if (
      entries.length > 0 &&
      entries.length % 2 === 0 &&
      entries.every((entry, index) =>
        index % 2 === 0
          ? entry === 'M'
          : unit.test(entry) && !entry.endsWith('.compat.test.ts') && lstatSync(entry).isFile(),
      )
    )
      files = entries.filter((_, index) => index % 2 === 1);
  } catch {}
}
console.error(files.length ? `Focused unit suite: ${files.length} changed files` : 'Full unit suite');
process.stdout.write(files.map((file) => `${file}\0`).join(''));
