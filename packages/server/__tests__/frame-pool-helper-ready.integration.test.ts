import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FramePool, type Device, type Frame } from '../src/frames.ts';

function jpeg(width: number, height: number): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

const FAKE_XCRUN = (shot: Buffer) => `#!${process.execPath}
const { appendFileSync, writeFileSync } = require('node:fs');
appendFileSync(process.env.XCRUN_CALLS, 'x\\n');
writeFileSync(process.argv.at(-1), Buffer.from('${shot.toString('base64')}', 'base64'));
`;

const FAKE_HELPER = `#!${process.execPath}
const message = (kind, body) => {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(body.length + 1, 0);
  header[4] = kind;
  process.stdout.write(Buffer.concat([header, body]));
};
process.on('SIGTERM', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
const artwork = { width: 450, height: 900, aperture: { x: 30, y: 20, width: 390, height: 844 }, cornerRadius: 12, quarterTurns: 0, background: 'bg', foreground: 'fg' };
message(2, Buffer.from(JSON.stringify({ deviceFrame: artwork })));
let sent = 0;
setInterval(() => {
  const size = Buffer.alloc(4);
  size.writeUInt16BE(390, 0);
  size.writeUInt16BE(844, 2);
  message(1, Buffer.concat([size, Buffer.from('helper ' + sent++)]));
}, 20);
`;

const device: Device = { platform: 'ios', udid: 'SIM-1', foldable: false };

let root: string;
let pool: FramePool;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-helper-ready-'));
  process.env.STIM_HOME = join(root, 'home');
  mkdirSync(join(root, 'home', 'server'), { recursive: true });
});

afterEach(async () => {
  await pool?.close();
  delete process.env.STIM_HOME;
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('a subscriber attached while the frame helper is being built', () => {
  it('moves from screenshots to the helper once it is ready, so it receives the device artwork', async () => {
    mkdirSync(join(root, 'bin'));
    const calls = join(root, 'xcrun-calls');
    writeFileSync(calls, '');
    writeFileSync(join(root, 'bin', 'xcrun'), FAKE_XCRUN(jpeg(390, 844)));
    chmodSync(join(root, 'bin', 'xcrun'), 0o755);
    const helper = join(root, 'stim-frames');
    writeFileSync(helper, FAKE_HELPER);
    chmodSync(helper, 0o755);
    const env = { ...process.env, PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`, XCRUN_CALLS: calls };

    let built: string | null = null;
    pool = new FramePool(env, undefined, () => built);
    const frames: Frame[] = [];
    const artwork: unknown[] = [];
    pool.subscribe(device, {
      frame: (frame) => frames.push(frame),
      artwork: (value) => artwork.push(value),
      delayed: () => {},
      failed: (message) => {
        throw new Error(message);
      },
    });

    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    expect(artwork).toEqual([]);
    expect(Buffer.from(frames[0]?.data ?? '', 'base64')).toEqual(jpeg(390, 844));

    built = helper;
    pool.helperReady();
    await vi.waitFor(() => expect(artwork).toHaveLength(1));
    expect(artwork[0]).toMatchObject({ width: 450, height: 900 });
    await vi.waitFor(() =>
      expect(Buffer.from(frames.at(-1)?.data ?? '', 'base64').toString('latin1')).toMatch(/helper \d+$/),
    );

    const screenshots = readFileSync(calls, 'utf8').length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(readFileSync(calls, 'utf8').length).toBe(screenshots);
  });
});
