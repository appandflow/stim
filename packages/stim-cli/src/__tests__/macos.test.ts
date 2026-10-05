import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  macosAppState,
  parseMacosRecord,
  readMacosRecord,
  type MacosAppRecord,
  type MacosProcess,
} from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { markClaimChildPending, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { macosRuntimeClaim, requiredMacosRecord } from '../macos/state.ts';
import { runStop } from '../commands/stop.ts';
import { stopMacosApp } from '../macos/stop.ts';
import { captureProcessToken, inspectProcessIdentity, waitForProcessExit } from '../process-identity.ts';
import { findCommandWorkspace, findProjectRoot } from '../workspace/project.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';
import { workspaceInUse } from '../workspace/in-use.ts';

let dir: string;
let root: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'stim-macos-')));
  root = join(dir, 'app');
  mkdirSync(root);
  process.env.STIM_HOME = join(dir, 'home');
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  rmSync(dir, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function record(patch: Partial<MacosAppRecord> = {}): MacosAppRecord {
  return {
    launchId: 'test-launch',
    arguments: [],
    product: 'Sample',
    bundle: join(root, 'Sample.app'),
    bundleId: 'dev.sample.stim.test',
    executable: join(root, 'Sample.app', 'Contents', 'MacOS', 'Sample'),
    build: { state: 'ok', startedAt: new Date().toISOString() },
    ...patch,
  };
}

async function ownedProcess(): Promise<MacosProcess> {
  const child = getExecutor().spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  await new Promise<void>((done, reject) => {
    child.once('spawn', done);
    child.once('error', reject);
  });
  const pid = child.pid!;
  const processToken = captureProcessToken(pid);
  expect(processToken).toBeTypeOf('string');
  return { pid, processToken: processToken!, startedAtMicros: 1 };
}

test('a Swift package inside a monorepo keeps its own command workspace', () => {
  writeFileSync(join(dir, 'package.json'), '{"name":"monorepo"}');
  writeFileSync(join(root, 'Package.swift'), '// swift-tools-version:6.0\n');
  const nested = join(root, 'Sources');
  mkdirSync(nested);
  expect(findProjectRoot(nested)).toBe(root);
  expect(findCommandWorkspace(nested)).toBe(root);
});

test('malformed app ownership is a refusal, never treated as no owned app', async () => {
  writeWorkspaceState(root, { macos: { ...record(), app: { pid: 42 } } });
  expect(parseMacosRecord({ ...record(), app: { pid: 42 } })).toBeNull();
  expect(() => requiredMacosRecord(root)).toThrow('owner is malformed');
  await expect(stopMacosApp(root)).rejects.toThrow('owner is malformed');
  expect(workspaceInUse(root)).toContain('its macOS process owner cannot be verified');
});

test('stop refuses an unverifiable owner without touching a live unrelated process', async () => {
  const bystander = await ownedProcess();
  writeWorkspaceState(root, { macos: record({ app: { ...bystander, processToken: 'invalid' } }) });
  await expect(stopMacosApp(root)).rejects.toThrow('Cannot verify macOS owner');
  expect(inspectProcessIdentity(bystander)).toBe('same');
  expect(readMacosRecord(root)?.app?.processToken).toBe('invalid');
});

test('stop terminates only the recorded app and keeps another app alive', async () => {
  const app = await ownedProcess();
  const bystander = await ownedProcess();
  writeWorkspaceState(root, { macos: record({ app }) });
  expect(macosAppState(readMacosRecord(root))?.state).toBe('orphaned');
  expect(await stopMacosApp(root)).toBe(true);
  expect(await waitForProcessExit(app, 1000)).toBe(true);
  expect(inspectProcessIdentity(bystander)).toBe('same');
  expect(macosAppState(readMacosRecord(root))?.state).toBe('stopped');
});

test('a dead build owner does not remain a running build in status', async () => {
  const owner = await ownedProcess();
  writeWorkspaceState(root, {
    macos: record({ supervisor: owner, build: { state: 'running', startedAt: new Date().toISOString() } }),
  });
  expect(macosAppState(readMacosRecord(root))?.build.state).toBe('running');
  children.at(-1)!.kill('SIGTERM');
  expect(await waitForProcessExit(owner, 1000)).toBe(true);
  expect(macosAppState(readMacosRecord(root))?.build).toMatchObject({
    state: 'failed',
    error: expect.stringContaining('before reporting a result'),
  });
});

test('an unresolved app-spawn claim blocks cleanup and refuses a successful stop', async () => {
  writeWorkspaceState(root, { macos: record() });
  const claim = tryAcquireClaim({ root: macosRuntimeClaim(root), mode: 'exclusive', label: 'macOS fixture' }).acquired;
  expect(claim).toBeDefined();
  try {
    markClaimChildPending(claim!);
    expect(workspaceInUse(root)).toContain('its macOS runtime claim is held');
    await expect(stopMacosApp(root)).rejects.toMatchObject({ code: 'STIM_MACOS_OWNER_UNVERIFIED' });
  } finally {
    releaseClaim(claim);
  }
});

test('a device-slot stop preserves the recorded macOS app and supervisor', async () => {
  const app = await ownedProcess();
  const supervisor = await ownedProcess();
  writeWorkspaceState(root, { macos: record({ app, supervisor }) });
  const result = await runStop({ root, slot: 'phone', project: null, collectors: {}, report: () => {} });
  expect(result.ok).toBe(true);
  expect(result.outcomes.macos).toBeUndefined();
  expect(inspectProcessIdentity(app)).toBe('same');
  expect(inspectProcessIdentity(supervisor)).toBe('same');
  expect(readMacosRecord(root)?.app).toEqual(app);
});
