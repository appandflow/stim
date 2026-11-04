import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isJsonObject } from '@stim-cli/core/state';
import { adbPath } from './frame-helper.ts';

const run = promisify(execFile);
const TOOL_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** A device's screen in the units agent-device records tap and swipe points in. */
export interface ScreenSize {
  width: number;
  height: number;
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

async function tool(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await run(file, args, {
    env,
    timeout: TOOL_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    encoding: 'utf8',
  });
  return stdout;
}

/**
 * The simulator's screen in points: agent-device taps a simulator in points, so the pixel size its device type
 * declares in `capabilities.plist` (the integrated display) divided by that display's scale.
 */
export async function simulatorScreen(udid: string, env: NodeJS.ProcessEnv): Promise<ScreenSize | null> {
  const devices: unknown = JSON.parse(await tool('xcrun', ['simctl', 'list', 'devices', '-j', udid], env));
  const runtimes = isJsonObject(devices) && isJsonObject(devices.devices) ? Object.values(devices.devices) : [];
  const device = runtimes
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .find((entry) => isJsonObject(entry) && entry.udid === udid);
  const identifier = isJsonObject(device) ? device.deviceTypeIdentifier : undefined;
  if (typeof identifier !== 'string') return null;
  const types: unknown = JSON.parse(await tool('xcrun', ['simctl', 'list', 'devicetypes', '-j'], env));
  const type = (isJsonObject(types) && Array.isArray(types.devicetypes) ? types.devicetypes : []).find(
    (entry) => isJsonObject(entry) && entry.identifier === identifier,
  );
  const bundle = isJsonObject(type) ? type.bundlePath : undefined;
  if (typeof bundle !== 'string') return null;
  const capabilities: unknown = JSON.parse(
    await tool(
      'plutil',
      ['-convert', 'json', '-o', '-', join(bundle, 'Contents', 'Resources', 'capabilities.plist')],
      env,
    ),
  );
  const inner = isJsonObject(capabilities) && isJsonObject(capabilities.capabilities) ? capabilities.capabilities : {};
  const display = (Array.isArray(inner.displays) ? inner.displays : []).find(
    (entry) => isJsonObject(entry) && entry.displayType === 'integrated',
  );
  if (!isJsonObject(display)) return null;
  const { width, height, scale } = display;
  return positive(width) && positive(height) && positive(scale)
    ? { width: width / scale, height: height / scale }
    : null;
}

/**
 * The emulator's or phone's screen in pixels: agent-device taps Android through `adb shell input` in pixels, so the
 * size `wm size` reports, an override first. It is the display's natural orientation.
 */
export async function androidScreen(serial: string, env: NodeJS.ProcessEnv): Promise<ScreenSize | null> {
  const text = await tool(adbPath(env), ['-s', serial, 'shell', 'wm', 'size'], env);
  const size = /Override size:\s*(\d+)x(\d+)/.exec(text) ?? /Physical size:\s*(\d+)x(\d+)/.exec(text);
  return size ? { width: Number(size[1]), height: Number(size[2]) } : null;
}
