import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';

assert.equal(process.platform, 'win32');
assert.ok(process.env.RUNNER_TEMP);
const evidence = resolve(process.env.RUNNER_TEMP, 'workspace-diff-diagnostic');
mkdirSync(evidence, { recursive: true });
const spawn = childProcess.spawn;
const commands = [];
let attempt = 0;
childProcess.spawn = (file, args, options) => {
  const record = { attempt, file, args, events: [], bytes: 0 };
  const observed = { ...options };
  if (file === 'git') {
    record.trace = join(evidence, `git-${commands.length}.ndjson`);
    observed.env = { ...options.env, GIT_TRACE2_EVENT: record.trace };
  }
  const child = spawn(file, args, observed);
  record.pid = child.pid;
  record.startedAt = new Date().toISOString();
  commands.push(record);
  const event = (name, detail) => record.events.push({ at: new Date().toISOString(), name, detail });
  child.stdout?.on('data', (chunk) => {
    record.bytes += chunk.length;
  });
  child.once('error', (error) => event('error', error.message));
  child.once('exit', (code, signal) => event('exit', { code, signal }));
  child.once('close', (code, signal) => event('close', { code, signal }));
  const kill = child.kill.bind(child);
  child.kill = (signal) => {
    event('kill', signal);
    return kill(signal);
  };
  return child;
};
syncBuiltinESMExports();
const { readWorkspaceDiff } = await import('../../../packages/server/src/workspace-diff.ts');
const cases = [];
for (attempt = 0; attempt < 40; attempt++) {
  const root = mkdtempSync(join(process.env.RUNNER_TEMP, 'stim-diff-diag-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const item = { attempt, root, startedAt: new Date().toISOString() };
  cases.push(item);
  try {
    const git = (...args) => childProcess.execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.name', 'Stim CI');
    git('config', 'user.email', 'stim-ci@example.invalid');
    writeFileSync(join(repo, 'source.txt'), 'original\n');
    git('add', '.');
    git('commit', '-qm', 'fixture');
    writeFileSync(join(repo, 'source.txt'), 'x'.repeat(300 * 1024));
    const result = await readWorkspaceDiff(repo, 'source.txt', process.env, new AbortController().signal);
    assert.deepEqual(result.patches[0], { section: 'unstaged', kind: 'too-large', text: '' });
    item.outcomeAt = new Date().toISOString();
    rmSync(root, { recursive: true, force: true });
    item.removedAt = new Date().toISOString();
  } catch (error) {
    item.failure = { at: new Date().toISOString(), code: error.code, message: error.message, stack: error.stack };
    process.exitCode = 1;
    break;
  }
}
childProcess.spawn = spawn;
syncBuiltinESMExports();
for (const item of cases) {
  if (item.removedAt) continue;
  try {
    rmSync(item.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    item.finalCleanupAt = new Date().toISOString();
  } catch (error) {
    item.cleanupFailure = { code: error.code, message: error.message };
    process.exitCode = 1;
  }
}
writeFileSync(
  join(evidence, 'summary.json'),
  JSON.stringify(
    {
      source: childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      node: process.version,
      git: childProcess.execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
      cases,
      commands,
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify({ attempts: cases.length, failures: cases.filter((item) => item.failure), evidence }));
