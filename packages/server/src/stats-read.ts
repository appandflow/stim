import { execFile, type ChildProcess } from 'node:child_process';
import { sep } from 'node:path';
import { findProjectRoot, readStatsReport, statsProjectKey } from '@stim-cli/core/state';

let git: ChildProcess | null = null;
let cancelled = false;
const cancel = () => {
  cancelled = true;
  git?.kill('SIGKILL');
};
process.on('SIGTERM', cancel);
process.on('message', (message) => {
  if (message === 'cancel') cancel();
});

function gitPath(root: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    git = execFile('git', ['-C', root, 'rev-parse', ...args], { encoding: 'utf8' }, (error, stdout) => {
      git = null;
      const path = error ? '' : stdout.trim();
      resolve(path ? (sep === '/' ? path : path.replaceAll('/', sep)) : null);
    });
  });
}

try {
  const root = findProjectRoot(process.cwd());
  const commonDir = root ? await gitPath(root, ['--path-format=absolute', '--git-common-dir']) : null;
  const repoRoot = root && !cancelled ? await gitPath(root, ['--show-toplevel']) : null;
  if (!cancelled) {
    const key = root ? statsProjectKey({ root, commonDir, repoRoot }) : null;
    const { report } = readStatsReport(key, Date.now());
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
} finally {
  if (process.connected) process.disconnect!();
}
