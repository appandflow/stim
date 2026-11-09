import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { processContext } from '../cli-operation.ts';
import { repairSourceCheckout } from '../diagnostics/doctor-source-repair.ts';
import { planSourceRepairs, type SourceCheckoutFacts } from '../diagnostics/doctor-source.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { warmClaimPath } from '../engine/warm-claim.ts';
import { processGroupAlive, readClaimSet } from '../ownership-claim.ts';
import { captureProcessIdentity, inspectProcessIdentity } from '../process-identity.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { makeChildProcess } from './_factories.ts';

const CONFLICT = [
  '[!] CocoaPods could not find compatible versions for pod "FirebaseCoreExtension":',
  '  In snapshot (Podfile.lock):',
  '    FirebaseCoreExtension (= 12.8.0)',
].join('\n');

let base: string;
let app: string;
let spawned: { cmd: string; args: string[] }[];
let notes: string[];
let retainBase: boolean;

function write(rel: string, value = ''): void {
  mkdirSync(dirname(join(app, rel)), { recursive: true });
  writeFileSync(join(app, rel), value);
}

/** Answers each `pod` and package-manager child from `outcomes`, keyed by its arguments; later runs of it succeed. */
function mockChildren(outcomes: Record<string, { code: number; out?: string }>): void {
  const pending = { ...outcomes };
  setExecutor({
    ...getExecutor(),
    spawn(cmd: string, args: string[]) {
      spawned.push({ cmd, args });
      const key = [cmd, ...args].join(' ');
      const outcome = pending[key] ?? { code: 0 };
      delete pending[key];
      const child = makeChildProcess({ pid: 4242 });
      setImmediate(() => {
        if (outcome.out) child.stdout?.emit('data', `${outcome.out}\n`);
        child.emit('exit', outcome.code, null);
        child.emit('close', outcome.code, null);
      });
      return child;
    },
  });
}

function facts(overrides: Partial<SourceCheckoutFacts> = {}): SourceCheckoutFacts {
  return {
    root: app,
    deps: null,
    pods: { iosDir: join(app, 'ios'), broken: true, state: null, iosTracked: false },
    prebuild: [],
    ...overrides,
  };
}

function repair(
  sourceFacts: SourceCheckoutFacts,
  confirm: ((question: string) => Promise<boolean>) | null = async () => true,
) {
  return repairSourceCheckout({
    facts: sourceFacts,
    repoRoot: app,
    settings: null,
    operation: processContext(app),
    confirm,
    note: (line) => notes.push(line),
  });
}

const podCommands = () => spawned.filter((call) => call.cmd === 'pod').map((call) => call.args.join(' '));

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stim-source-repair-'));
  app = join(base, 'app');
  process.env.STIM_HOME = join(base, 'stim-home');
  spawned = [];
  notes = [];
  retainBase = false;
  mkdirSync(app, { recursive: true });
  execFileSync('git', ['init', '-q', app]);
  write('package.json', JSON.stringify({ name: 'app' }));
  write('ios/Podfile');
  write('ios/Podfile.lock', 'PODS: []\n');
  mkdirSync(join(app, 'ios', 'Pods', 'Headers'), { recursive: true });
});

afterEach(() => {
  resetExecutor();
  delete process.env.STIM_HOME;
  if (retainBase) throw new Error(`Could not verify pod cleanup; retained ${base}.`);
  rmSync(base, { recursive: true, force: true });
});

test.skipIf(process.platform === 'win32')(
  'a conflict with Podfile.lock updates only the named pods, and retries the clean install once links stay broken (find -L over ios/Pods, which exists only on macOS; skipped on win32)',
  async () => {
    symlinkSync(join(app, 'gone.h'), join(app, 'ios', 'Pods', 'Headers', 'gone.h'));
    mockChildren({ 'pod install --clean-install': { code: 1, out: CONFLICT } });
    expect(await repair(facts())).toBe(0);
    expect(podCommands()).toEqual([
      'install --clean-install',
      'update FirebaseCoreExtension',
      'install --clean-install',
    ]);
    expect(notes.join('\n')).toContain('updating only that pod');
  },
);

test('a conflict the update resolves is not retried when no link is broken', async () => {
  mockChildren({ 'pod install': { code: 1, out: CONFLICT } });
  expect(
    await repair(facts({ pods: { iosDir: join(app, 'ios'), broken: false, state: 'stale', iosTracked: false } })),
  ).toBe(0);
  expect(podCommands()).toEqual(['install', 'update FirebaseCoreExtension']);
});

test('a pod the update then names is updated together with the first, and a repeated name stops the loop', async () => {
  const conflict = (pod: string) => `[!] CocoaPods could not find compatible versions for pod "${pod}":`;
  mockChildren({
    'pod install': { code: 1, out: conflict('FirebaseCoreExtension') },
    'pod update FirebaseCoreExtension': { code: 1, out: conflict('Firebase/CoreOnly') },
    'pod update FirebaseCoreExtension Firebase': { code: 1, out: conflict('Firebase/CoreOnly') },
  });
  expect(
    await repair(facts({ pods: { iosDir: join(app, 'ios'), broken: false, state: 'stale', iosTracked: false } })),
  ).toBe(1);
  expect(podCommands()).toEqual(['install', 'update FirebaseCoreExtension', 'update FirebaseCoreExtension Firebase']);
});

test('a conflict in a git-tracked ios/ is refused with the manual command and nothing is updated', async () => {
  mockChildren({ 'pod install --clean-install': { code: 1, out: CONFLICT } });
  const sourceFacts = facts({ pods: { iosDir: join(app, 'ios'), broken: true, state: null, iosTracked: true } });
  expect(await repair(sourceFacts)).toBe(1);
  expect(podCommands()).toEqual(['install --clean-install']);
  expect(notes.join('\n')).toContain('pod update FirebaseCoreExtension');
});

test('without a terminal every step is announced with its manual command and none runs', async () => {
  mockChildren({});
  expect(await repair(facts(), null)).toBe(0);
  expect(spawned).toEqual([]);
  expect(notes.join('\n')).toContain('pod install --clean-install');
  expect(notes.join('\n')).toContain('not run without a terminal');
});

test('a step the person declines does not run and is not a failure', async () => {
  mockChildren({});
  expect(await repair(facts(), async () => false)).toBe(0);
  expect(spawned).toEqual([]);
});

test('each step is confirmed on its own, and declining the dependencies skips the steps that read them', async () => {
  write('package-lock.json', '{}');
  mockChildren({});
  const questions: string[] = [];
  const sourceFacts = facts({ deps: { root: app, command: 'npm ci', reason: 'missing' } });
  expect(planSourceRepairs(sourceFacts).map((step) => step.id)).toEqual(['deps', 'pods']);
  const answers = [false, true];
  await repair(sourceFacts, async (question) => {
    questions.push(question);
    return answers.shift() ?? false;
  });
  expect(questions).toHaveLength(2);
  expect(spawned).toEqual([]);
  expect(notes.join('\n')).toContain('the dependencies are not repaired');
});

test('a failed dependency install stops the steps that read the dependencies', async () => {
  write('package-lock.json', '{}');
  mockChildren({ 'npm ci': { code: 1 } });
  const sourceFacts = facts({ deps: { root: app, command: 'npm ci', reason: 'stale' } });
  expect(await repair(sourceFacts)).toBe(1);
  expect(spawned.map((call) => `${call.cmd} ${call.args.join(' ')}`)).toEqual(['npm ci']);
  expect(notes.join('\n')).toContain('skipped: the dependencies are not repaired');
});

test.skipIf(process.platform === 'win32')(
  'unverified pod cleanup retains native and warm ownership before later prebuild',
  { timeout: 30_000 },
  async () => {
    const marker = join(base, 'pod-child');
    const real = getExecutor();
    let group: number | undefined;
    setExecutor({
      ...real,
      spawn(cmd, args, options) {
        spawned.push({ cmd, args: [...args] });
        if (cmd !== 'pod') return real.spawn(cmd, args, options);
        const script = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:'ignore'}); writeFileSync(${JSON.stringify(marker)},String(child.pid)); child.unref();`;
        const child = spawn(process.execPath, ['-e', script], { ...options, detached: true });
        group = child.pid;
        return child;
      },
    });
    const clock = Date.now;
    let advance = 0;
    const time = vi.spyOn(Date, 'now').mockImplementation(() => clock() + advance++ * 360_000);
    let descendant: { pid: number; processToken: string } | null = null;
    let cleanupFailure: unknown;
    try {
      const source = facts({
        pods: { iosDir: join(app, 'ios'), broken: false, state: 'stale', iosTracked: false },
        prebuild: [{ platform: 'android', status: { kind: 'unfinished' } }],
      });
      expect(planSourceRepairs(source).map((step) => step.id)).toEqual(['pods', 'prebuild:android']);
      await expect(repair(source)).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
      expect(podCommands()).toEqual(['install']);
      expect(spawned.some(({ cmd }) => cmd !== 'pod')).toBe(false);
      expect(existsSync(marker)).toBe(true);
      const identity = captureProcessIdentity(Number(readFileSync(marker, 'utf8')));
      if (!identity.ok) throw new Error('could not identify owned pod descendant');
      descendant = { pid: Number(readFileSync(marker, 'utf8')), processToken: identity.token };
      expect(readClaimSet(warmClaimPath(app)).live).toEqual(
        expect.arrayContaining([expect.objectContaining({ childDeclared: true })]),
      );
      expect(readClaimSet(join(workspaceDir(app), 'native-run.lock')).live).toEqual(
        expect.arrayContaining([expect.objectContaining({ childDeclared: true })]),
      );
    } finally {
      time.mockRestore();
      if (!descendant && existsSync(marker)) {
        const pid = Number(readFileSync(marker, 'utf8'));
        const identity = captureProcessIdentity(pid);
        if (identity.ok) descendant = { pid, processToken: identity.token };
        else retainBase = true;
      }
      if (descendant && inspectProcessIdentity(descendant) === 'same') {
        try {
          process.kill(descendant.pid, 'SIGKILL');
        } catch (error) {
          if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ESRCH')
            cleanupFailure = error;
        }
      }
      const until = Date.now() + 5000;
      if (group)
        while (processGroupAlive(group) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
      if (group && processGroupAlive(group)) retainBase = true;
      if (cleanupFailure) retainBase = true;
    }
    if (retainBase) throw new Error(`Could not verify pod cleanup; retained ${base}.`, { cause: cleanupFailure });
  },
);

test('a workspace a stim run holds is refused before anything is asked or run', async () => {
  mockChildren({});
  const asked: string[] = [];
  const held = withWorkspaceProcessLock(
    workspaceDir(app),
    'native-run',
    async () => {
      const result = await repair(facts(), async (question) => {
        asked.push(question);
        return true;
      });
      return result;
    },
    { external: true, details: { command: 'ios' } },
  );
  expect(await held).toBe(1);
  expect(asked).toEqual([]);
  expect(spawned).toEqual([]);
  expect(notes.join('\n')).toContain('stim ios');
});
