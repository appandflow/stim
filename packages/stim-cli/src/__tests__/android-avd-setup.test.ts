import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearDevice, getProject, removeProject, setDevice, upsertProject } from '../workspace/config.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { prepareOwnedAvd } from '../engine/android-avd-setup.ts';
import { deleteProjectDevices } from '../commands/gc/devices.ts';
import { acquireAvdClaim } from '../avd-claim.ts';
import { processGroupAlive, readClaimSet, releaseClaim } from '@stim-cli/core/ownership-claim';
import { teardownOwnedAvd } from '../teardown.ts';
import { makeExitingChild } from './_factories.ts';
import * as processIdentity from '@stim-cli/core/process-identity';

let home: string;
let project: string;
let avdRoot: string;
let saved: Record<string, string | undefined>;
let beforeCreate: () => void;
let beforeProbe: () => void;
const avdName = 'stim-setup';
const envKeys = [
  'STIM_HOME',
  'HOME',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'ANDROID_AVD_HOME',
  'ANDROID_SDK_HOME',
  'ANDROID_USER_HOME',
  'ANDROID_EMULATOR_HOME',
];

function createFiles(): void {
  const directory = join(avdRoot, `${avdName}.avd`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(avdRoot, `${avdName}.ini`), `path=${directory}\n`);
  writeFileSync(join(directory, 'config.ini'), 'disk.dataPartition.size=10G\n');
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-avd-setup-')));
  project = join(home, 'project');
  avdRoot = join(home, 'avds');
  saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    STIM_HOME: join(home, 'stim'),
    HOME: home,
    ANDROID_HOME: join(home, 'sdk'),
    ANDROID_SDK_ROOT: join(home, 'sdk'),
    ANDROID_AVD_HOME: avdRoot,
    ANDROID_SDK_HOME: home,
    ANDROID_USER_HOME: join(home, '.android'),
    ANDROID_EMULATOR_HOME: join(home, '.android'),
  });
  for (const abi of ['arm64-v8a', 'x86_64'])
    mkdirSync(join(home, 'sdk', 'system-images', 'android-36', 'google_apis', abi), { recursive: true });
  mkdirSync(project);
  mkdirSync(avdRoot);
  upsertProject(project, {});
  beforeCreate = () => {};
  beforeProbe = () => {};
  const run = (command: string): string => {
    if (command.includes('create avd')) {
      beforeCreate();
      if (existsSync(join(avdRoot, `${avdName}.ini`))) throw new Error(`AVD ${avdName} already exists`);
      createFiles();
      return '';
    }
    if (command === 'emulator -list-avds') return existsSync(join(avdRoot, `${avdName}.ini`)) ? avdName : '';
    if (command === 'adb devices') {
      beforeProbe();
      return 'List of devices attached\n';
    }
    if (command.includes('delete avd')) {
      rmSync(join(avdRoot, `${avdName}.ini`), { force: true });
      rmSync(join(avdRoot, `${avdName}.avd`), { recursive: true, force: true });
      return '';
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  setExecutor({
    run,
    spawn(command, args = []) {
      try {
        run([command, ...args].join(' '));
        return makeExitingChild();
      } catch (error) {
        return makeExitingChild(1, (error as Error).message);
      }
    },
    runQuiet: (command) => {
      try {
        return run(command);
      } catch {
        return null;
      }
    },
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function prepare(configure: (name: string) => void = () => {}): ReturnType<typeof prepareOwnedAvd> {
  return prepareOwnedAvd({ projectPath: project, label: 'setup', configuration: 'fixture', configure });
}

const configWriter = `
const { upsertProject } = await import(process.argv[1]);
upsertProject(process.argv[2], { label: 'other workspace' });
`;

test('another process can write config during AVD creation while cleanup preserves the reservation', async () => {
  beforeCreate = () => {
    expect(existsSync(join(process.env.STIM_HOME!, 'config.lock'))).toBe(false);
    expect(getProject(project)?.platforms?.android).toMatchObject({ avdName, owned: true, setupIncomplete: true });
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        configWriter,
        new URL('../workspace/config.ts', import.meta.url).href,
        join(home, 'other'),
      ],
      { timeout: 3000, env: process.env },
    );
    expect(getProject(join(home, 'other'))?.label).toBe('other workspace');
    const partial = join(avdRoot, `${avdName}.avd`);
    mkdirSync(partial);
    writeFileSync(join(partial, 'partial'), 'keep');
    expect(teardownOwnedAvd(avdName, { del: true }).status).toBe('failed');
    expect(deleteProjectDevices([], [], [{ kind: 'android', id: avdName, project, owned: true }])).toBe(1);
    expect(() => removeProject(project)).toThrow(/another operation/);
    expect(readFileSync(join(partial, 'partial'), 'utf8')).toBe('keep');
    expect(getProject(project)?.platforms?.android?.setupIncomplete).toBe(true);
  };
  expect((await prepare()).created).toBe(true);
  expect(getProject(project)?.platforms?.android?.setupIncomplete).toBeUndefined();
  releaseClaim(acquireAvdClaim(avdName));
});

test('recovery probes outside the config lock and preserves a replacement reservation', async () => {
  createFiles();
  beforeProbe = () => {
    expect(existsSync(join(process.env.STIM_HOME!, 'config.lock'))).toBe(false);
    setDevice(project, 'android', { avdName: 'stim-replacement', owned: true });
  };
  await expect(prepare()).rejects.toThrow(/concurrent Stim run/);
  expect(getProject(project)?.platforms?.android?.avdName).toBe('stim-replacement');
});

test('a stale missing-device scan cannot clear a newly completed AVD', async () => {
  const stale = { kind: 'android' as const, id: avdName, project, owned: true };
  await prepare();
  expect(deleteProjectDevices([], [], [stale])).toBe(0);
  expect(getProject(project)?.platforms?.android?.avdName).toBe(avdName);
  expect(existsSync(join(avdRoot, `${avdName}.ini`))).toBe(true);
});

test('a stale registered-orphan scan cannot delete an AVD after recovery assigns it', async () => {
  createFiles();
  expect((await prepare()).created).toBe(false);
  expect(deleteProjectDevices([{ kind: 'android', id: avdName, name: avdName }], [], [])).toBe(1);
  expect(getProject(project)?.platforms?.android?.avdName).toBe(avdName);
  expect(existsSync(join(avdRoot, `${avdName}.ini`))).toBe(true);
});

test('cleanup revalidates the slot that owns an AVD', async () => {
  await prepare();
  clearDevice(project, 'android');
  setDevice(project, 'android', { avdName, owned: true }, 'qa');
  expect(teardownOwnedAvd(avdName, { del: true, owner: { projectPath: project } })).toMatchObject({
    status: 'failed',
    reason: expect.stringContaining('(qa)'),
  });
  expect(existsSync(join(avdRoot, `${avdName}.ini`))).toBe(true);
  expect(teardownOwnedAvd(avdName, { del: true, owner: { projectPath: project, slot: 'qa' } }).status).toBe(
    'torn-down',
  );
});

test('record removal stays inside the teardown claim', async () => {
  await prepare();
  const outcome = teardownOwnedAvd(avdName, {
    del: true,
    owner: { projectPath: project },
    onRemoved: () => {
      expect(() => acquireAvdClaim(avdName)).toThrow(/another operation/);
    },
  });
  expect(outcome.status).toBe('torn-down');
  releaseClaim(acquireAvdClaim(avdName));
});

test.each([true, false])(
  'rollback preserves a newer record with the same name (artifacts exist: %s)',
  async (artifactsExist) => {
    await expect(
      prepareOwnedAvd({
        projectPath: project,
        label: 'setup',
        configuration: 'fixture',
        configure: () => {
          throw new Error('disk full');
        },
        teardown: (name, options) => {
          setDevice(project, 'android', { avdName, owned: true, deviceName: 'replacement' });
          if (!artifactsExist) {
            rmSync(join(avdRoot, `${avdName}.ini`));
            rmSync(join(avdRoot, `${avdName}.avd`), { recursive: true });
          }
          return teardownOwnedAvd(name, options);
        },
      }),
    ).rejects.toThrow(/remains tracked for cleanup/);
    expect(existsSync(join(avdRoot, `${avdName}.ini`))).toBe(artifactsExist);
    expect(getProject(project)?.platforms?.android?.deviceName).toBe('replacement');
  },
);

const childCreator = `
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const { setExecutor } = await import(process.argv[1]);
const { prepareOwnedAvd } = await import(process.argv[2]);
setExecutor({ spawn(command, args, options) {
  const name = args[args.indexOf('-n') + 1];
  const dir = path.join(process.env.ANDROID_AVD_HOME, name + '.avd');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'partial'), 'keep');
  if (process.argv[4] === 'create') process.exit(0);
  return spawn(process.execPath, ['-e',
    'require("node:fs").writeFileSync(process.argv[1], process.argv[2])',
    path.join(process.env.ANDROID_AVD_HOME, name + '.ini'), 'path=' + dir + '\\n'
  ], options);
} });
const prepared = await prepareOwnedAvd({ projectPath: process.argv[3], label: 'setup', configuration: 'fixture', configure() { if (process.argv[4] === 'configure') process.exit(0); } });
console.log(JSON.stringify(prepared));
`;

function runCreator(stage: 'create' | 'configure' | 'complete', projectPath = project): string {
  return execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      childCreator,
      new URL('../exec.ts', import.meta.url).href,
      new URL('../engine/android-avd-setup.ts', import.meta.url).href,
      projectPath,
      stage,
    ],
    { timeout: 3000, env: process.env, encoding: 'utf8' },
  );
}

test('an interrupted native creation retains its reservation and refuses cleanup without a child identity', () => {
  runCreator('create');
  expect(getProject(project)?.platforms?.android).toMatchObject({ avdName, setupIncomplete: true });
  expect(() => removeProject(project)).toThrow(/killed before recording/);
  expect(teardownOwnedAvd(avdName, { del: true }).status).toBe('failed');
  expect(deleteProjectDevices([], [], [{ kind: 'android', id: avdName, project, owned: true }])).toBe(1);
  expect(readFileSync(join(avdRoot, `${avdName}.avd`, 'partial'), 'utf8')).toBe('keep');
  expect(readdirSync(join(process.env.STIM_HOME!, 'avd-locks'))).toHaveLength(1);
});

test('an interruption after native creation returns permits cleanup once the creator is gone', () => {
  runCreator('configure');
  expect(getProject(project)?.platforms?.android).toMatchObject({ avdName, setupIncomplete: true });
  expect(teardownOwnedAvd(avdName, { del: true, owner: { projectPath: project } }).status).toBe('torn-down');
  expect(existsSync(join(avdRoot, `${avdName}.avd`))).toBe(false);
});

test('another workspace creating the same label while the first is reserved receives a distinct AVD', async () => {
  const other = join(home, 'other');
  upsertProject(other, {});
  let secondName: string | undefined;
  beforeCreate = () => {
    secondName = JSON.parse(runCreator('complete', other)).avdName;
    expect(secondName).toMatch(/^stim-setup-[a-f0-9]{8}$/);
    expect(getProject(other)?.platforms?.android?.avdName).toBe(secondName);
    expect(getProject(project)?.platforms?.android?.setupIncomplete).toBe(true);
  };
  expect((await prepare()).avdName).toBe(avdName);
  expect(
    readdirSync(avdRoot)
      .filter((name) => name.endsWith('.ini'))
      .toSorted(),
  ).toEqual([`${avdName}.ini`, `${secondName}.ini`].toSorted());
});

const nativeWriter = `
const fs = require('node:fs');
const path = require('node:path');
const [directory, mode, ...args] = process.argv.slice(1);
const name = args[args.indexOf('-n') + 1];
const avd = path.join(directory, name + '.avd');
fs.mkdirSync(avd, { recursive: true });
fs.writeFileSync(path.join(directory, name + '.ini'), 'path=' + avd + '\\n');
fs.writeFileSync(path.join(avd, 'partial'), 'keep');
fs.writeFileSync(path.join(directory, 'argv.json'), JSON.stringify(args));
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(directory, 'input.txt'), input);
  if (mode === 'hold') {
    const timer = setInterval(() => {
      if (fs.existsSync(path.join(directory, 'finish'))) clearInterval(timer);
    }, 20);
  } else if (mode === 'descendant') {
    require('node:child_process').spawn(process.execPath, ['-e',
      'const fs = require("node:fs"); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) clearInterval(timer); }, 20);',
      path.join(directory, 'finish')
    ], { stdio: 'ignore' }).unref();
  }
});
`;

function claimState() {
  return readClaimSet(join(process.env.STIM_HOME!, 'avd-locks', `${avdName}.lock`));
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the fixture process.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function failChildIdentity(): void {
  const capture = processIdentity.captureProcessIdentity;
  vi.spyOn(processIdentity, 'captureProcessIdentity').mockImplementation((pid) =>
    pid === process.pid ? capture(pid) : { ok: false, reason: 'fixture child identity unavailable' },
  );
}

test.each([false, true])(
  'completed creation releases its claim (child identity unavailable: %s)',
  async (unavailable) => {
    if (unavailable) failChildIdentity();
    setExecutor({
      ...getExecutor(),
      spawn(_file, args, options) {
        return spawn(process.execPath, ['-e', nativeWriter, avdRoot, 'complete', ...args!], options);
      },
    });
    expect(await prepare()).toMatchObject({ avdName, created: true });
    expect(readFileSync(join(avdRoot, 'input.txt'), 'utf8')).toBe('no\n');
    expect(JSON.parse(readFileSync(join(avdRoot, 'argv.json'), 'utf8'))).toEqual([
      'create',
      'avd',
      '-n',
      avdName,
      '-k',
      `system-images;android-36;google_apis;${process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64'}`,
      '--device',
      'pixel_6',
    ]);
    expect(claimState().live).toEqual([]);
    releaseClaim(acquireAvdClaim(avdName));
  },
);

test.each(['throw', 'error'])('a spawn %s releases the claim and retains the incomplete reservation', async (kind) => {
  setExecutor({
    ...getExecutor(),
    spawn() {
      if (kind === 'throw') throw new Error('fixture spawn failed');
      return spawn(join(home, 'missing-avdmanager'));
    },
  });
  await expect(prepare()).rejects.toThrow(kind === 'throw' ? 'fixture spawn failed' : 'ENOENT');
  expect(getProject(project)?.platforms?.android).toMatchObject({ avdName, setupIncomplete: true });
  releaseClaim(acquireAvdClaim(avdName));
});

test.each([false, true])(
  'a surviving native descendant retains the claim (child identity unavailable: %s)',
  async (unavailable) => {
    if (unavailable) failChildIdentity();
    let child: ChildProcess | undefined;
    setExecutor({
      ...getExecutor(),
      spawn(_file, args, options) {
        child = spawn(process.execPath, ['-e', nativeWriter, avdRoot, 'descendant', ...args!], options);
        return child;
      },
    });
    try {
      await expect(prepare()).rejects.toThrow('process group running');
      const holder = claimState().live[0];
      expect(holder?.childDeclared).toBe(true);
      expect(Boolean(holder?.child)).toBe(!unavailable);
      expect(getProject(project)?.platforms?.android?.setupIncomplete).toBe(true);
      expect(() => acquireAvdClaim(avdName)).toThrow(/another operation|recording/);
    } finally {
      writeFileSync(join(avdRoot, 'finish'), 'done');
      if (child?.pid !== undefined) await until(() => !processGroupAlive(child!.pid!));
    }
  },
);

test('a killed creator leaves its recorded native child protected until the group exits', async () => {
  const callerSource = `
import { spawn } from 'node:child_process';
const { setExecutor } = await import(process.argv[1]);
const { prepareOwnedAvd } = await import(process.argv[2]);
setExecutor({ spawn(file, args, options) {
  return spawn(process.execPath, ['-e', ${JSON.stringify(nativeWriter)}, process.argv[4], 'hold', ...args], options);
} });
await prepareOwnedAvd({ projectPath: process.argv[3], label: 'setup', configuration: 'fixture', configure() {} });
`;
  const caller = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      callerSource,
      new URL('../exec.ts', import.meta.url).href,
      new URL('../engine/android-avd-setup.ts', import.meta.url).href,
      project,
      avdRoot,
    ],
    { env: process.env, stdio: 'ignore' },
  );
  const callerDone = new Promise((resolve) => caller.once('exit', resolve));
  let nativePid: number | undefined;
  try {
    await until(() => Boolean(claimState().live[0]?.child) && existsSync(join(avdRoot, 'input.txt')));
    nativePid = claimState().live[0]!.child!.pid;
    caller.kill('SIGKILL');
    await callerDone;
    expect(claimState().live[0]?.child?.pid).toBe(nativePid);
    expect(teardownOwnedAvd(avdName, { del: true, owner: { projectPath: project } }).status).toBe('failed');
    expect(getProject(project)?.platforms?.android?.setupIncomplete).toBe(true);
    expect(readFileSync(join(avdRoot, `${avdName}.avd`, 'partial'), 'utf8')).toBe('keep');
    writeFileSync(join(avdRoot, 'finish'), 'done');
    await until(() => !processGroupAlive(nativePid!));
    expect(
      teardownOwnedAvd(avdName, {
        del: true,
        owner: { projectPath: project },
        onRemoved: () => clearDevice(project, 'android'),
      }).status,
    ).toBe('torn-down');
    expect(getProject(project)?.platforms?.android).toBeUndefined();
    expect(existsSync(join(avdRoot, `${avdName}.avd`))).toBe(false);
  } finally {
    if (caller.exitCode === null && caller.signalCode === null) caller.kill('SIGKILL');
    await callerDone;
    writeFileSync(join(avdRoot, 'finish'), 'done');
    if (nativePid !== undefined) await until(() => !processGroupAlive(nativePid!));
  }
}, 10000);
