import { existsSync, globSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getExecutor } from '../../../packages/stim-cli/src/exec.ts';

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

export function removeGradleHome(home) {
  const entry = lstatSync(home, { throwIfNoEntry: false });
  if (!entry) return;
  if (entry.isSymbolicLink()) throw new Error(`Cannot remove a symlink Gradle home: ${home}`);
  const canonical = realpathSync(home);
  const owner = Number(readFileSync(join(canonical, 'owner.pid'), 'utf8').trim());
  if (!Number.isInteger(owner) || owner <= 0 || (owner !== process.pid && isAlive(owner))) {
    throw new Error(`Cannot prove Gradle home is unused: ${canonical}`);
  }
  const daemonRoot = join(canonical, 'daemon');
  if (existsSync(daemonRoot) && realpathSync(daemonRoot) !== daemonRoot) {
    throw new Error(`Gradle daemon registry leaves its owned home: ${daemonRoot}`);
  }
  const deadline = Date.now() + 60000;
  const daemonPids = () =>
    globSync('daemon/*/daemon-*.out.log', { cwd: canonical }).map((path) => {
      const match = /\/daemon-(\d+)\.out\.log$/.exec(path);
      if (!match) throw new Error(`Unrecognized Gradle daemon log: ${path}`);
      return Number(match[1]);
    });
  const versions = globSync('daemon/*/registry.bin', { cwd: canonical }).map((path) => path.split('/')[1]);
  for (const version of versions) {
    const registry = join(daemonRoot, version, 'registry.bin');
    if (realpathSync(registry) !== registry) {
      throw new Error(`Gradle daemon registry leaves its owned home: ${registry}`);
    }
    const binaries = globSync('wrapper/dists/*/*/*/bin/gradle', { cwd: canonical }).filter(
      (path) => path.split('/').at(-3) === `gradle-${version}`,
    );
    if (!binaries.length) {
      if (daemonPids().some(isAlive)) throw new Error(`No cached Gradle ${version} to stop daemons in ${canonical}`);
      continue;
    }
    getExecutor().runFile(join(canonical, binaries[0]), ['--stop', '--gradle-user-home', canonical], {
      cwd: canonical,
      env: { GRADLE_USER_HOME: canonical },
      omitEnv: ['GRADLE_OPTS', 'JAVA_OPTS', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS'],
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
  }
  while (daemonPids().some(isAlive)) {
    if (Date.now() >= deadline) throw new Error(`Gradle daemons did not exit; preserving ${canonical}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  rmSync(canonical, { recursive: true, force: true });
}
