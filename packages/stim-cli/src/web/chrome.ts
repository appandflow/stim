import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WebViewport } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';

export const CHROME_INSTALL_REMEDY =
  'Install Google Chrome from https://www.google.com/chrome/ (or Chromium), then run `stim doctor`.';

const MAC_APPS = [
  ['Google Chrome.app', 'Google Chrome'],
  ['Chromium.app', 'Chromium'],
] as const;

const PATH_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

function chromeCandidates(
  host: NodeJS.Platform,
  { home = homedir(), env = process.env }: { home?: string; env?: NodeJS.ProcessEnv } = {},
): string[] {
  if (host === 'darwin') {
    return ['/Applications', join(home, 'Applications')].flatMap((dir) =>
      MAC_APPS.map(([app, binary]) => join(dir, app, 'Contents', 'MacOS', binary)),
    );
  }
  if (host === 'win32') {
    return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
      .filter((dir): dir is string => Boolean(dir))
      .map((dir) => join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return [];
}

/** The installed Chrome or Chromium executable Stim launches, or null when none is installed. */
export function findChrome({
  host = process.platform,
  exists = existsSync,
  findExecutable = (name: string) => getExecutor().findExecutable(name),
}: {
  host?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  findExecutable?: (name: string) => string | null;
} = {}): string | null {
  const installed = chromeCandidates(host).find((path) => exists(path));
  if (installed) return installed;
  for (const name of PATH_NAMES) {
    const found = findExecutable(name);
    if (found) return found;
  }
  return null;
}

const DESKTOP_WINDOW = { width: 1280, height: 800 } as const;

export const PHONE_SCREEN = { width: 390, height: 844, deviceScaleFactor: 3 } as const;

export function chromeArgs({
  profile,
  port,
  headless,
  ignoreCertificateErrors,
  viewport,
}: {
  profile: string;
  port: number;
  headless: boolean;
  ignoreCertificateErrors: boolean;
  viewport: WebViewport;
}): string[] {
  const window = viewport === 'phone' ? PHONE_SCREEN : DESKTOP_WINDOW;
  return [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    ...(headless ? ['--headless'] : []),
    `--window-size=${window.width},${window.height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--disable-background-networking',
    '--disable-sync',
    // macOS Chrome asks for Keychain access to encrypt a new profile's secrets; these keep it off the Keychain.
    '--password-store=basic',
    '--use-mock-keychain',
    ...(ignoreCertificateErrors ? ['--ignore-certificate-errors'] : []),
    'about:blank',
  ];
}
