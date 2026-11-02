import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { ledgerUdids, readSimulators, recordedPids } from './platform.mjs';
import { pool, run, sleep } from './shell.mjs';

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

export async function createWorkspaces(ctx, count) {
  const { project, stim, emit } = ctx;
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

// A recorded pid is the run's only if it is alive, started after the run did, and still carries a stim title or path of this run.
async function liveOurs(pids, { home, worktreePrefix, sinceMs }) {
  if (!pids.size) return [];
  const listed = await run('ps', ['-ww', '-o', 'pid=,lstart=,command=', '-p', [...pids].join(',')]);
  const ours = (cmd) =>
    /^stim-(supervisor|collector|daemon)/.test(cmd) || cmd.includes(home) || cmd.includes(worktreePrefix);
  return listed.stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]{8} \d{4})\s+(.*)$/.exec(line))
    .filter((match) => match && Date.parse(match[2]) >= sinceMs - 2000 && ours(match[3]))
    .map((match) => Number(match[1]));
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

export async function teardown(ctx) {
  const { stim, project, home, emit } = ctx;
  const report = { worktrees: [], simulators: [], processes: [], trashEmpty: null, homeDeleted: false, errors: [] };
  const note = (error) => report.errors.push(String(error?.message ?? error));
  const noAbort = { signal: undefined };

  ctx.trackLedger();
  const pids = new Set([...ctx.knownPids, ...recordedPids(home)]);
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
    if (!existsSync(workspace.path)) return;
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
    report.worktrees.push({ label: workspace.label, removed: !existsSync(workspace.path) });
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
  report.trashEmpty = await waitFor(() => !existsSync(trash) || readdirSync(trash).length === 0, 180_000);

  emit('teardown', "waiting for the run's stim processes to exit");
  const scope = { home, worktreePrefix: ctx.worktreePrefix, sinceMs: ctx.startedAt };
  await waitFor(async () => (await liveOurs(pids, scope)).length === 0, 200_000);
  report.processes = await liveOurs(pids, scope);
  for (const pid of report.processes) signal(pid, 'SIGTERM');
  if (report.processes.length) {
    await sleep(3000);
    for (const pid of await liveOurs(new Set(report.processes), scope)) signal(pid, 'SIGKILL');
  }

  try {
    await ctx.beforeHomeDelete?.();
    const survivors = report.simulators.filter((sim) => !sim.deleted).length;
    if (sims === null || survivors) {
      note(
        `the private home ${home} is kept: its ledger is the proof that ${sims === null ? 'the' : survivors} simulator(s) are the run's`,
      );
    } else if (dirname(home) === ctx.homeDir && basename(home).startsWith(ctx.runId)) {
      rmSync(home, { recursive: true, force: true });
      report.homeDeleted = !existsSync(home);
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

export function trackLedger(ctx) {
  for (const udid of ledgerUdids(ctx.home)) ctx.createdUdids.add(udid);
  for (const pid of recordedPids(ctx.home)) ctx.knownPids.add(pid);
}
