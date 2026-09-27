import { basename } from 'node:path';

type AutomationPlatform = 'ios' | 'android' | 'web';

/**
 * A tool Stim reports as `activity.driver.tool` when it drives a device. Entries are checked in array order and
 * the first match wins, so a specific matcher must come before a generic one that also matches its command line.
 */
export interface AutomationTool {
  tool: string;
  platforms: readonly AutomationPlatform[];
  /** A host process whose command line also names the simulator's UDID or the emulator's serial. */
  host?: RegExp;
  /** An on-device process in `adb shell ps -A -o PID,ARGS` output. */
  instrumentation?: RegExp;
  /** A DevTools client connected to the owned Chrome's debugging port. */
  cdp?: RegExp;
}

export const AUTOMATION_TOOLS: readonly AutomationTool[] = [
  { tool: 'agent-browser', platforms: ['web'], cdp: /agent-browser/i },
  {
    tool: 'agent-device',
    platforms: ['ios', 'android', 'web'],
    host: /agent-device/i,
    cdp: /agent-device/i,
  },
  {
    tool: 'argent',
    platforms: ['ios', 'android', 'web'],
    host: /\/bin\/[\w-]+\/(simulator-server(\.exe)?\s+(ios|android|android_device)|ax-service)\b|com\.argent\.androiddevtools/,
    instrumentation: /com\.argent\.androiddevtools/,
    cdp: /@swmansion\/argent\/dist\/tool-server/,
  },
  { tool: 'idb', platforms: ['ios'], host: /idb_companion/ },
  { tool: 'maestro', platforms: ['ios', 'android'], host: /maestro/i },
  {
    tool: 'appium',
    platforms: ['ios', 'android'],
    host: /appium|WebDriverAgent/i,
  },
  {
    tool: 'xcodebuild',
    platforms: ['ios'],
    host: /\bxcodebuild\b.*\btest(-without-building)?\b/,
  },
  { tool: 'simctl', platforms: ['ios'], host: /\bsimctl\s+(io|spawn)\b/ },
  {
    tool: 'uiautomator',
    platforms: ['android'],
    instrumentation: /uiautomator/,
  },
  {
    tool: 'instrumentation',
    platforms: ['android'],
    instrumentation: /androidx\.test|\binstrument\b/,
  },
  {
    tool: 'chrome-devtools-mcp',
    platforms: ['web'],
    cdp: /chrome-devtools-mcp/i,
  },
  { tool: 'playwright', platforms: ['web'], cdp: /playwright/i },
  { tool: 'puppeteer', platforms: ['web'], cdp: /puppeteer/i },
];

const HOST_EXCLUSIONS = [/\bsimctl\s+spawn\b.*\blog\s+stream\b/, /\blogcat\b/];

/** Stim's own DevTools clients: the browser supervisor, `stim-frames` in stim-server, Stim Desktop, the stim CLI. */
const CDP_EXCLUSIONS = [
  /\bstim-(frames|server|web)\b|StimDesktop|\/stim(-cli)?\/(dist|bin)\/|\/bin\/stim(\s|$)|^stim(\s|$)/,
];

function namesDevice(command: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`).test(command);
}

/** The tool a host process drives the device `id` with, or null when the command does not name the device. */
export function hostDriverTool(command: string, platform: 'ios' | 'android', id: string): string | null {
  if (!namesDevice(command, id) || HOST_EXCLUSIONS.some((pattern) => pattern.test(command))) return null;
  return (
    AUTOMATION_TOOLS.find((entry) => entry.platforms.includes(platform) && entry.host?.test(command))?.tool ?? null
  );
}

/** The tool behind an on-device process's arguments, or null when it is not instrumentation. */
export function instrumentationTool(args: string): string | null {
  return (
    AUTOMATION_TOOLS.find((entry) => entry.platforms.includes('android') && entry.instrumentation?.test(args))?.tool ??
    null
  );
}

/**
 * The tool a DevTools client's command line names, or null for Stim's own clients. A client no entry names is
 * reported by its script or executable name.
 */
export function cdpClientTool(command: string): string | null {
  if (CDP_EXCLUSIONS.some((pattern) => pattern.test(command))) return null;
  const known = AUTOMATION_TOOLS.find((entry) => entry.platforms.includes('web') && entry.cdp?.test(command));
  if (known) return known.tool;
  const [executable = '', script] = command.trim().split(/\s+/);
  const name = basename(executable);
  return (/^(node|bun|deno|python3?)$/.test(name) && script ? basename(script) : name) || 'unknown DevTools client';
}
