import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { getExecutor } from '../../../packages/stim-cli/src/exec.ts';
import { readMacosProcess } from '../../../packages/stim-cli/src/macos-process.ts';
import { readProcessArgs, readProcessStartTime } from '../../../packages/stim-cli/src/process-args.ts';
import { verifyCollectorOwnership } from '../../../packages/stim-cli/src/collector/ownership.ts';

const executor = getExecutor();
const [mode, sentinel, checker] = process.argv.slice(2);
if (mode === 'denied') {
  assert.equal(readMacosProcess(process.pid), null);
} else {
  assert.throws(() => readFileSync(sentinel));
  assert.throws(() => executor.runFile('/bin/ps', ['-p', String(process.pid), '-o', 'command=']));
  const root = `${process.env.STIM_HOME}/workspace with spaces`;
  const title = `stim-collector-ios --root ${root}`;
  const child = executor.spawn(
    process.execPath,
    ['-e', `process.title = ${JSON.stringify(title)}; console.log('ready'); setInterval(() => {}, 1000)`],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const exited = once(child, 'exit');
  await once(child.stdout, 'data');
  try {
    assert.deepEqual(readProcessArgs(child.pid).filter(Boolean), [title]);
    assert(readProcessStartTime(child.pid) instanceof Date);
    assert.equal(verifyCollectorOwnership({ pid: child.pid, platform: 'ios', root }).status, 'ours');
    assert.equal(
      verifyCollectorOwnership({ pid: child.pid, platform: 'ios', root: `${root}/other` }).status,
      'unverified',
    );
    child.kill();
    await exited;
    assert.equal(verifyCollectorOwnership({ pid: child.pid, platform: 'ios', root }).status, 'gone');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
  }
  const holder = executor.spawn(checker, ['zombie'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const holderExit = once(holder, 'exit');
  const lines = createInterface({ input: holder.stdout });
  try {
    const [line] = await once(lines, 'line');
    const pid = Number(line);
    let observation;
    for (let attempt = 0; attempt < 100; attempt++) {
      observation = readMacosProcess(pid);
      if (observation?.zombie) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(observation?.zombie, true);
    assert.equal(readProcessArgs(pid), null);
    assert.equal(readProcessStartTime(pid), null);
  } finally {
    holder.stdin.end('\n');
    await holderExit;
    lines.close();
  }
}
console.log(`sandbox process ${mode} passed`);
