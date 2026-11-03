import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  ledgerUdids,
  parsePs,
  provenOurs,
  readSimulators,
  noteRecorded,
  recordIdentities,
  recordedPids,
} from './platform.mjs';
import { C_LOCALE, pool, run, sleep } from './shell.mjs';

export class HarnessError extends Error {}

const pad = (n) => String(n).padStart(2, '0');

export function podEnvironment(project, { home = homedir(), exists = existsSync, read = readFileSync } = {}) {
  const env = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
  let wanted = null;
  try {
    wanted = /^ruby\s+['"]([\d.]+)['"]/m.exec(read(join(project, 'Gemfile'), 'utf8'))?.[1] ?? null;
  } catch {}
  if (!wanted) {
    try {
      wanted =
        read(join(project, '.ruby-version'), 'utf8')
          .trim()
          .replace(/^ruby-/, '') || null;
    } catch {}
  }
  const bin = wanted ? join(home, '.rvm', 'rubies', `ruby-${wanted}`, 'bin') : null;
  if (bin && exists(bin)) {
    const gems = join(home, '.rvm', 'gems', `ruby-${wanted}`);
    env.PATH = `${bin}:${gems}/bin:${env.PATH}`;
    env.GEM_HOME = gems;
    env.GEM_PATH = `${gems}:${gems}@global`;
  }
  return { env, ruby: wanted, fromRvm: Boolean(bin && exists(bin)) };
}

async function danglingLinks(dir) {
  if (!existsSync(dir)) return 0;
  const found = await run('find', [dir, '-type', 'l'], { timeoutMs: 600_000 });
  if (found.code !== 0 || found.timedOut)
    throw new HarnessError(
      `listing the symlinks under ${dir} failed (exit ${found.code}${found.timedOut ? ', timed out' : ''})`,
    );
  return found.stdout.split('\n').filter((link) => link && !existsSync(link)).length;
}

async function dropSourceMachineEnv(workspace) {
  const file = join(workspace.path, 'ios', '.xcode.env.local');
  if (!existsSync(file)) return false;
  const tracked = await run('git', ['ls-files', '--error-unmatch', 'ios/.xcode.env.local'], { cwd: workspace.path });
  if (tracked.code === 0) return false;
  rmSync(file);
  return true;
}

async function prepareNativeDirs(ctx, workspace) {
  const ios = join(workspace.path, 'ios');
  if (!existsSync(join(ios, 'Podfile'))) return { skipped: 'no ios/Podfile' };
  const before = await danglingLinks(join(ios, 'Pods'));
  if (before === 0) return { skipped: 'no dangling Pods links' };
  const bundled = existsSync(join(workspace.path, 'Gemfile'));
  const [cmd, args] = bundled ? ['bundle', ['exec', 'pod', 'install']] : ['pod', ['install']];
  const result = await run(cmd, args, { cwd: ios, env: ctx.pods.env, timeoutMs: 20 * 60_000, signal: ctx.signal });
  ctx.logFile(`pod-install-${workspace.label}.log`, `${result.stdout}\n${result.stderr}`);
  if (result.code !== 0)
    throw new HarnessError(
      `pod install failed in ${workspace.label} (exit ${result.code}); see pod-install-${workspace.label}.log`,
    );
  const tracked = await run('git', ['ls-files', '--error-unmatch', 'ios/Podfile.lock'], { cwd: workspace.path });
  if (tracked.code === 0) await run('git', ['checkout', '--', 'ios/Podfile.lock'], { cwd: workspace.path });
  if (existsSync(join(ios, 'Podfile.lock')))
    copyFileSync(join(ios, 'Podfile.lock'), join(ios, 'Pods', 'Manifest.lock'));
  const after = await danglingLinks(join(ios, 'Pods'));
  return { dangling: before, remaining: after };
}

const PODFILE_LOCK = 'ios/Podfile.lock';

function freePath(base) {
  if (!existsSync(base)) return base;
  for (let n = 1; ; n++) if (!existsSync(`${base}.${n}`)) return `${base}.${n}`;
}

// Rung 5 of the pressure ladder deletes a workspace's Pods only when its ios/Podfile.lock equals the source checkout's,
// and the worktrees carry the committed one; the file it replaces is kept in <out>/restored, under a new name when
// that directory already holds one. Only the working-tree file changes, so a staged version stays staged.
export async function restoreProjectLockfile(ctx) {
  const { project, emit, out } = ctx;
  const committed = await run('git', ['show', `HEAD:${PODFILE_LOCK}`], { cwd: project });
  const file = join(project, PODFILE_LOCK);
  if (committed.code !== 0 || !existsSync(file) || readFileSync(file, 'utf8') === committed.stdout) return false;
  const kept = freePath(join(out, 'restored', 'ios-Podfile.lock.original'));
  mkdirSync(dirname(kept), { recursive: true });
  copyFileSync(file, kept);
  writeFileSync(file, committed.stdout);
  emit(
    'setup',
    `restored the committed ${PODFILE_LOCK} in the project (it differed from HEAD); the previous file is kept at ${kept}`,
  );
  return true;
}

export async function createWorkspaces(ctx, count) {
  const { project, stim, emit } = ctx;
  await restoreProjectLockfile(ctx);
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: project })).stdout.trim();
  const parent = ctx.workDir;
  mkdirSync(parent, { recursive: true });
  ctx.commit = head;
  for (let i = 1; i <= count; i++) {
    const label = `${ctx.runId}-${pad(i)}`;
    const path = join(parent, label);
    const added = await run('git', ['-C', project, 'worktree', 'add', '--detach', path, head], { signal: ctx.signal });
    if (added.code !== 0) throw new HarnessError(`git worktree add failed for ${label}: ${added.stderr.trim()}`);
    ctx.workspaces.push({ index: i - 1, label, path, role: null });
  }
  emit('setup', `created ${count} worktrees at ${head.slice(0, 9)} under ${parent}`);

  const warmed = await pool(ctx.workspaces, 4, (workspace) =>
    stim.exec(`warm-${workspace.label}`, workspace.path, ['worktree', 'warm']),
  );
  const badWarm = warmed.find((result) => !result.ok);
  if (badWarm)
    throw new HarnessError(`stim worktree warm failed in ${badWarm.cwd}: ${badWarm.stderr.trim().slice(-400)}`);
  emit('setup', `warmed ${count} worktrees`);

  const dropped = (await pool(ctx.workspaces, 4, dropSourceMachineEnv)).filter(Boolean).length;
  if (dropped)
    emit(
      'setup',
      `dropped ios/.xcode.env.local, which holds the source machine's node path, from ${dropped} worktrees`,
    );

  const pods = await pool(ctx.workspaces, 2, (workspace) => prepareNativeDirs(ctx, workspace));
  const repaired = pods.filter((result) => result.dangling).length;
  emit(
    'setup',
    `pod install in ${repaired} of ${count} worktrees (${pods.find((r) => r.skipped)?.skipped ?? 'dangling Pods links found'})`,
  );
  const stillBroken = pods.findIndex((result) => result.remaining);
  if (stillBroken >= 0)
    emit('setup', `warning: ${ctx.workspaces[stillBroken].label} still has dangling Pods links after pod install`);

  const plans = await pool(ctx.workspaces, 4, (workspace) =>
    stim.exec(`plan-${workspace.label}`, workspace.path, ['ios', '--plan', '--json']),
  );
  const prints = plans.map((plan) => plan.json?.fingerprint ?? null);
  if (prints.some((print) => !print) || new Set(prints).size !== 1) {
    throw new HarnessError(
      `the worktrees do not share one fingerprint (${[...new Set(prints)].join(', ')}), so every run would compile cold; ` +
        'the project needs matching Pods and lockfiles in each worktree',
    );
  }
  ctx.fingerprint = prints[0];
  emit('setup', `all ${count} worktrees fingerprint ${prints[0].slice(0, 8)}`);
  return ctx.workspaces;
}

const scopeOf = (ctx) => ({ home: ctx.home, worktreePrefix: ctx.worktreePrefix });

async function psRows(pids) {
  if (!pids.length) return [];
  const listed = await run('ps', ['-ww', '-o', 'pid=,ppid=,rss=,lstart=,command=', '-p', pids.join(',')], {
    env: C_LOCALE(),
  });
  return parsePs(listed.stdout);
}

async function liveOurs(ctx) {
  const rows = await psRows([...ctx.identities.keys()]);
  return provenOurs(rows, ctx.identities, scopeOf(ctx)).map((row) => row.pid);
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch {}
}

async function waitFor(check, timeoutMs, stepMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(stepMs);
  }
  return check();
}

export function removalState(path, parent, exists = existsSync) {
  if (exists(path)) return false;
  return exists(parent) ? true : null;
}

export async function teardown(ctx) {
  const { stim, project, home, emit } = ctx;
  const report = {
    worktrees: [],
    simulators: [],
    processes: [],
    trashEmpty: null,
    homeDeleted: false,
    ballastGone: null,
    unverified: [],
    uncleanPaths: [],
    errors: [],
  };
  const note = (error) => report.errors.push(String(error?.message ?? error));
  const noAbort = { signal: undefined };

  await ctx.trackLedger();
  const homeVanished = !existsSync(home);
  const unverifiable = (path) => {
    report.unverified.push(path);
    report.uncleanPaths.push(path);
  };
  if (homeVanished)
    note(`the private home ${home} is not there at the start of teardown, so nothing in it can be checked`);
  emit('teardown', 'stim stop in every worktree');
  await pool(ctx.workspaces, 4, async (workspace) => {
    if (existsSync(workspace.path))
      await stim.exec(`teardown-stop-${workspace.label}`, workspace.path, ['stop', '--json'], {
        timeoutMs: 180_000,
        uninterruptible: true,
      });
  }).catch(note);

  emit('teardown', 'stim worktree remove in every worktree');
  await pool(ctx.workspaces, 4, async (workspace) => {
    if (!existsSync(workspace.path)) {
      const gone = removalState(workspace.path, ctx.workDir);
      report.worktrees.push({ label: workspace.label, path: workspace.path, removed: gone });
      if (gone === null) unverifiable(workspace.path);
      return;
    }
    const removed = await stim.exec(
      `teardown-remove-${workspace.label}`,
      workspace.path,
      ['worktree', 'remove', '--force'],
      { timeoutMs: 300_000, uninterruptible: true },
    );
    if (!removed.ok || existsSync(workspace.path)) {
      await run('git', ['-C', project, 'worktree', 'remove', '--force', workspace.path], noAbort);
      if (existsSync(workspace.path)) rmSync(workspace.path, { recursive: true, force: true });
    }
    const state = removalState(workspace.path, ctx.workDir);
    report.worktrees.push({ label: workspace.label, path: workspace.path, removed: state });
    if (state === null) unverifiable(workspace.path);
    else if (state === false) report.uncleanPaths.push(workspace.path);
  }).catch(note);

  emit('teardown', 'deleting leftover simulators from the run ledger');
  const owned = ctx.createdUdids;
  const sims = await readSimulators(60_000);
  if (sims === null) note("simctl list failed, so the run's simulators could not be checked");
  for (const sim of (sims ?? []).filter((s) => owned.has(s.udid))) {
    if (sim.state === 'Booted' || sim.state === 'Booting')
      await run('xcrun', ['simctl', 'shutdown', sim.udid], { timeoutMs: 120_000 });
    const deleted = await run('xcrun', ['simctl', 'delete', sim.udid], { timeoutMs: 120_000 });
    report.simulators.push({ udid: sim.udid, name: sim.name, deleted: deleted.code === 0 });
  }

  const trash = join(home, 'trash');
  report.trashEmpty = homeVanished
    ? null
    : await waitFor(() => !existsSync(trash) || readdirSync(trash).length === 0, 180_000);

  emit('teardown', "waiting for the run's stim processes to exit");
  await waitFor(async () => (await liveOurs(ctx)).length === 0, 200_000);
  report.processes = await liveOurs(ctx);
  for (const pid of report.processes) signal(pid, 'SIGTERM');
  if (report.processes.length) {
    await sleep(3000);
    const still = new Set(await liveOurs(ctx));
    for (const pid of report.processes) if (still.has(pid)) signal(pid, 'SIGKILL');
  }

  if (ctx.ballast) {
    try {
      await ctx.ballast.release();
      ctx.ballast.remove();
    } catch (error) {
      note(error);
    }
    const state = removalState(ctx.ballast.file, ctx.homeDir);
    report.ballastGone = state;
    if (state === null) unverifiable(ctx.ballast.file);
    else if (state === false) {
      note(`the ballast file ${ctx.ballast.file} is still there`);
      report.uncleanPaths.push(ctx.ballast.file);
    }
  }

  try {
    await ctx.beforeHomeDelete?.();
    const survivors = report.simulators.filter((sim) => !sim.deleted).length;
    if (sims === null || survivors) {
      note(
        `the private home ${home} is kept: its ledger is the proof that ${sims === null ? 'the' : survivors} simulator(s) are the run's`,
      );
      report.uncleanPaths.push(home);
    } else if (homeVanished) {
      report.homeDeleted = null;
      unverifiable(home);
    } else if (dirname(home) === ctx.homeDir && basename(home).startsWith(ctx.runId)) {
      rmSync(home, { recursive: true, force: true });
      report.homeDeleted = removalState(home, ctx.homeDir);
      if (report.homeDeleted === null) unverifiable(home);
      else if (report.homeDeleted === false) report.uncleanPaths.push(home);
    }
  } catch (error) {
    note(error);
  }
  for (const dir of ctx.createdDirs.toReversed()) {
    try {
      rmdirSync(dir);
    } catch {}
  }
  return report;
}

export async function trackLedger(ctx) {
  for (const udid of ledgerUdids(ctx.home)) ctx.createdUdids.add(udid);
  noteRecorded(ctx.recordedAt, recordedPids(ctx.home), Date.now());
  const fresh = [...ctx.recordedAt.keys()].filter((pid) => !ctx.identities.has(pid));
  if (fresh.length) recordIdentities(ctx.identities, await psRows(fresh), ctx.recordedAt, scopeOf(ctx), ctx.startedAt);
}
