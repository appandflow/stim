import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceLeasePath, parseLease, raiseLease, takeLease } from '../engine/device-lease.ts';
import { createLeaseTickets } from '../stimd/lease-tickets.ts';

test('shared operation grants release their run lease only after the last ticket', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-ticket-home-'));
  const root = mkdtempSync(join(tmpdir(), 'stim-ticket-app-'));
  vi.stubEnv('STIM_HOME', home);
  const ownerA = new Socket();
  const ownerB = new Socket();
  const controllerA = new AbortController();
  const controllerB = new AbortController();
  const tickets = createLeaseTickets();
  const request = {
    root,
    platform: 'ios' as const,
    slot: 'default',
    id: 'phone',
    deviceName: null,
    idLabel: 'udid',
    waitSeconds: 0,
    noWait: false,
    installBoundMs: 60_000,
    appId: null,
  };
  try {
    const a = tickets.prepare(ownerA, request, controllerA.signal);
    const b = tickets.prepare(ownerB, request, controllerB.signal);
    const first = await tickets.acquire(a, ownerA, () => {});
    const pendingSecond = tickets.acquire(b, ownerB, () => {});
    tickets.release(a, ownerA);
    const second = await pendingSecond;
    expect(first.status).toBe('leased');
    expect(second.status).toBe('leased');
    const path = deviceLeasePath('ios', 'phone');
    const token = parseLease(readFileSync(path, 'utf8'))?.token;
    expect(parseLease(readFileSync(path, 'utf8'))?.token).toBe(token);
    tickets.release(b, ownerB);
    expect(() => readFileSync(path)).toThrow(/ENOENT/);
  } finally {
    ownerA.destroy();
    ownerB.destroy();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a disconnected grant protects the shared run token through its existing expiry', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-ticket-home-'));
  const root = mkdtempSync(join(tmpdir(), 'stim-ticket-app-'));
  vi.stubEnv('STIM_HOME', home);
  const ownerA = new Socket();
  const ownerB = new Socket();
  const tickets = createLeaseTickets();
  const request = {
    root,
    platform: 'ios' as const,
    slot: 'default',
    id: 'phone',
    deviceName: null,
    idLabel: 'udid',
    waitSeconds: 0,
    noWait: false,
    installBoundMs: 60_000,
    appId: null,
  };
  try {
    const a = tickets.prepare(ownerA, request, new AbortController().signal);
    const b = tickets.prepare(ownerB, request, new AbortController().signal);
    await tickets.acquire(a, ownerA, () => {});
    await tickets.acquire(b, ownerB, () => {});
    const started = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(started + 30_000);
    expect(raiseLease({ root, platform: 'ios', minMs: 120_000 }).status).toBe('raised');
    const path = deviceLeasePath('ios', 'phone');
    const before = parseLease(readFileSync(path, 'utf8'));
    tickets.drop(ownerA);
    now.mockReturnValue(started + 70_000);
    tickets.release(b, ownerB);
    expect(parseLease(readFileSync(path, 'utf8'))).toEqual(before);
  } finally {
    ownerA.destroy();
    ownerB.destroy();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a declared device lock survives its operation ticket', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-ticket-home-'));
  const root = mkdtempSync(join(tmpdir(), 'stim-ticket-app-'));
  vi.stubEnv('STIM_HOME', home);
  const owner = new Socket();
  const tickets = createLeaseTickets();
  try {
    const declared = takeLease({ root, platform: 'ios', id: 'phone', kind: 'declared' });
    expect(declared.status).toBe('taken');
    const ticket = tickets.prepare(
      owner,
      {
        root,
        platform: 'ios',
        slot: 'default',
        id: 'phone',
        deviceName: null,
        idLabel: 'udid',
        waitSeconds: 0,
        noWait: false,
        installBoundMs: 60_000,
        appId: null,
      },
      new AbortController().signal,
    );
    expect(await tickets.acquire(ticket, owner, () => {})).toMatchObject({ status: 'leased', kind: 'declared' });
    tickets.drop(owner);
    expect(parseLease(readFileSync(deviceLeasePath('ios', 'phone'), 'utf8'))?.holder).toBe(root);
  } finally {
    owner.destroy();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('disconnecting a pending ticket does not take another workspace lease', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-ticket-home-'));
  const root = mkdtempSync(join(tmpdir(), 'stim-ticket-app-'));
  const other = mkdtempSync(join(tmpdir(), 'stim-ticket-other-'));
  vi.stubEnv('STIM_HOME', home);
  const owner = new Socket();
  const controller = new AbortController();
  const tickets = createLeaseTickets();
  try {
    expect(takeLease({ root: other, platform: 'ios', id: 'phone', kind: 'run' }).status).toBe('taken');
    const ticket = tickets.prepare(
      owner,
      {
        root,
        platform: 'ios',
        slot: 'default',
        id: 'phone',
        deviceName: null,
        idLabel: 'udid',
        waitSeconds: 60,
        noWait: false,
        installBoundMs: 60_000,
        appId: null,
      },
      controller.signal,
    );
    const pending = tickets.acquire(ticket, owner, () => {});
    controller.abort();
    tickets.drop(owner);
    await expect(pending).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
    expect(parseLease(readFileSync(deviceLeasePath('ios', 'phone'), 'utf8'))?.holder).toBe(other);
  } finally {
    owner.destroy();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('releasing the last ticket wakes a waiting workspace without a polling delay', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-ticket-home-'));
  const root = mkdtempSync(join(tmpdir(), 'stim-ticket-app-'));
  const other = mkdtempSync(join(tmpdir(), 'stim-ticket-other-'));
  vi.stubEnv('STIM_HOME', home);
  const ownerA = new Socket();
  const ownerB = new Socket();
  const tickets = createLeaseTickets();
  const request = {
    root,
    platform: 'ios' as const,
    slot: 'default',
    id: 'phone',
    deviceName: null,
    idLabel: 'udid',
    waitSeconds: 60,
    noWait: false,
    installBoundMs: 60_000,
    appId: null,
  };
  try {
    const a = tickets.prepare(ownerA, request, new AbortController().signal);
    const b = tickets.prepare(ownerB, { ...request, root: other }, new AbortController().signal);
    expect(await tickets.acquire(a, ownerA, () => {})).toMatchObject({ status: 'leased' });
    const pending = tickets.acquire(b, ownerB, () => {});
    const start = Date.now();
    tickets.release(a, ownerA);
    expect(await pending).toMatchObject({ status: 'leased' });
    expect(Date.now() - start).toBeLessThan(1_000);
    tickets.release(b, ownerB);
  } finally {
    ownerA.destroy();
    ownerB.destroy();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('a no-wait ticket leaves the other workspace lease in place', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-ticket-home-'));
  const root = mkdtempSync(join(tmpdir(), 'stim-ticket-app-'));
  const other = mkdtempSync(join(tmpdir(), 'stim-ticket-other-'));
  vi.stubEnv('STIM_HOME', home);
  const owner = new Socket();
  const tickets = createLeaseTickets();
  const warnings: string[] = [];
  try {
    expect(takeLease({ root: other, platform: 'android', id: 'phone', kind: 'run' }).status).toBe('taken');
    const ticket = tickets.prepare(
      owner,
      {
        root,
        platform: 'android',
        slot: 'default',
        id: 'phone',
        deviceName: null,
        idLabel: 'serial',
        waitSeconds: 0,
        noWait: true,
        installBoundMs: 60_000,
        appId: null,
      },
      new AbortController().signal,
    );
    expect(await tickets.acquire(ticket, owner, (line) => warnings.push(line))).toEqual({ status: 'unleased' });
    expect(warnings[0]).toContain('--no-wait');
    tickets.drop(owner);
    expect(parseLease(readFileSync(deviceLeasePath('android', 'phone'), 'utf8'))?.holder).toBe(other);
  } finally {
    owner.destroy();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
