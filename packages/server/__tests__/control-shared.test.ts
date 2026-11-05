import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseClaim, tryAcquireClaim, type ClaimHandle } from '@stim-cli/core/ownership-claim';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ControlHub, type Controller, type InputCommand } from '../src/control.ts';
import { FramePool, type Device } from '../src/frames.ts';
import type { PresenceParticipant, ServerMessage } from '../src/protocol.ts';

const device: Device = { platform: 'ios', udid: 'SIM-UDID', foldable: false };

let home: string;
let claim: ClaimHandle;
let frames: FramePool;
let hub: ControlHub;
let sent: Record<string, unknown>[];
let attached: number;

function controller(id: string): Controller & { ended: ServerMessage[] } {
  const ended: ServerMessage[] = [];
  return { device: { id, name: id }, send: (message) => ended.push(message), ended };
}

async function begin(owner: Controller): Promise<string> {
  const begun = await hub.beginHosted(
    owner,
    { workspace: '/client/app', platform: 'ios' },
    home,
    device,
    frames,
    () => true,
    claim,
  );
  if ('code' in begun) throw new Error(begun.message);
  return begun.session;
}

const touch = (phase: 'down' | 'move' | 'up', x: number): InputCommand => ({ input: 'touch', phase, x, y: 0.5 });
const touches = () => sent.filter((command) => command.input === 'touch').map((command) => [command.phase, command.x]);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-control-shared-'));
  const acquired = tryAcquireClaim({ root: join(home, 'session.claims'), mode: 'exclusive' }).acquired;
  if (!acquired) throw new Error('no session claim');
  claim = acquired;
  sent = [];
  attached = 0;
  frames = new FramePool(process.env);
  vi.spyOn(frames, 'control').mockImplementation(() => {
    attached++;
    return {
      send: (command) => sent.push(command),
      keys: () => true,
      clipboard: async () => null,
      detach: () => attached--,
    };
  });
  vi.spyOn(frames, 'litDisplay').mockReturnValue(0);
  hub = new ControlHub({
    frameHelper: () => null,
    env: process.env,
    stimCli: join(home, 'unused-cli.mjs'),
    frames,
    subscribeStatus: () => () => {},
    audit: () => {},
    lockLimits: { timeoutMs: 1000, maxOutputBytes: 1024 },
    idleMs: 60_000,
    renewMs: 60_000,
    leaseFor: '1m',
    foldHelper: async () => join(home, 'sim-fold'),
    foldTimeoutMs: 5000,
    conflict: () => {},
  });
});

afterEach(async () => {
  await hub.close();
  await frames.close();
  vi.restoreAllMocks();
  releaseClaim(claim);
  rmSync(home, { recursive: true, force: true });
});

it('accepts two clients that begin controlling one device at once, and one ending leaves the other', async () => {
  const desktop = controller('desktop');
  const phone = controller('phone');
  const [first, second] = await Promise.all([begin(desktop), begin(phone)]);
  expect(first).not.toBe(second);
  expect(attached).toBe(1);

  expect(hub.endById(desktop, first)).toBe(true);
  expect(attached).toBe(1);
  expect(await hub.input(phone, second, { input: 'text', text: 'hi' })).toBeNull();
  expect(sent).toContainEqual({ input: 'text', text: 'hi' });
  expect(phone.ended).toEqual([]);

  hub.endById(phone, second);
  expect(attached).toBe(0);
});

it("keeps each client's touches to its own gesture on the device's one pointer", async () => {
  const desktop = controller('desktop');
  const phone = controller('phone');
  const mine = await begin(desktop);
  const theirs = await begin(phone);

  expect(await hub.input(desktop, mine, touch('down', 0.1))).toBeNull();
  expect(await hub.input(phone, theirs, touch('down', 0.9))).toMatchObject({ code: 'device-busy', busy: 'Host' });
  expect(await hub.input(phone, theirs, touch('up', 0.9))).toBeNull();
  expect(await hub.input(desktop, mine, touch('move', 0.2))).toBeNull();
  expect(touches()).toEqual([
    ['down', 0.1],
    ['move', 0.2],
  ]);

  hub.endById(desktop, mine);
  expect(touches().at(-1)).toEqual(['up', 0.2]);
  expect(await hub.input(phone, theirs, touch('down', 0.9))).toBeNull();
  expect(touches().at(-1)).toEqual(['down', 0.9]);
});

it("keeps one share viewer's up from lifting another client's finger", async () => {
  const share = controller('share-1');
  const desktop = controller('desktop');
  const viewers = await begin(share);
  const mine = await begin(desktop);
  const viewer: PresenceParticipant = { id: 'share-1-v1', kind: 'viewer', name: 'Ada', color: 2 };

  expect(await hub.input(desktop, mine, touch('down', 0.1))).toBeNull();
  expect(await hub.input(share, viewers, touch('up', 0.5), viewer)).toBeNull();
  expect(await hub.input(share, viewers, touch('down', 0.5), viewer)).toMatchObject({ busy: 'Host' });
  expect(await hub.input(desktop, mine, touch('up', 0.1))).toBeNull();
  expect(await hub.input(share, viewers, touch('down', 0.5), viewer)).toBeNull();
  expect(await hub.input(desktop, mine, touch('down', 0.3))).toMatchObject({ busy: 'Ada' });
  expect(touches()).toEqual([
    ['down', 0.1],
    ['up', 0.1],
    ['down', 0.5],
  ]);
});

it('turns the device keyboard off again when the session that turned it on ends, before the input closes', async () => {
  const desktop = controller('desktop');
  const id = await begin(desktop);
  hub.deviceKeyboard(desktop, id, true);
  expect(sent.at(-1)).toEqual({ input: 'deviceKeyboard', enabled: true });
  hub.endById(desktop, id);
  expect(sent.at(-1)).toEqual({ input: 'deviceKeyboard', enabled: false });
  expect(attached).toBe(0);

  const phone = controller('phone');
  const next = await begin(phone);
  const before = sent.length;
  hub.endById(phone, next);
  expect(sent).toHaveLength(before);
});
