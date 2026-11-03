import { execFile } from 'node:child_process';
import type { StatusPayload } from '@stim-cli/core/state';
import type { ShareRequest } from './share.ts';

const MIDDOT = String.fromCharCode(0xb7);
const MAX_TITLE_PART = 60;
const LOOKUP_TIMEOUT_MS = 5000;
const PLATFORM_LABEL = { ios: 'iOS', android: 'Android', macos: 'macOS', web: 'web' } as const;

/** Text an app or device names itself with, made safe for a tab title: no control or bidi characters, one line, short. */
export function cleanTitleText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const capped = [...text].slice(0, MAX_TITLE_PART).join('').trim();
  return capped || null;
}

/** `stim-label (iPhone 18 Pro 27.0)` is `iPhone 18 Pro`: the label and the runtime version stay out of a public title. */
export function deviceModel(name: string | null | undefined): string | null {
  if (!name) return null;
  const inner = name.startsWith('stim-') ? /^stim-.*? \((.+)\)\s*$/u.exec(name)?.[1] : name;
  return inner ? cleanTitleText(inner.replace(/\s+\d+\.\d+(?:\.\d+)*$/u, '')) : null;
}

/** An AVD device profile such as `pixel_8` is `Pixel 8`. */
export function androidModel(profile: string | null | undefined): string | null {
  if (!profile || !/^[a-z0-9_.-]+$/u.test(profile)) return null;
  return cleanTitleText(
    profile
      .replace(/[_-]+/gu, ' ')
      .replace(/(^|\s)([a-z])/gu, (_, space: string, letter: string) => space + letter.toUpperCase()),
  );
}

export interface TitleFacts {
  /** The app process id: a bundle id or an Android package. Never shown. */
  appId: string | null;
  model: string | null;
}

/** What the status payload says about the shared device, for a local owned device only. */
export function titleFacts(
  payload: StatusPayload | null,
  request: Pick<ShareRequest, 'workspace' | 'platform' | 'slot' | 'physical'>,
): TitleFacts {
  const none = { appId: null, model: null };
  if (!payload || !Array.isArray(payload.environments) || request.physical) return none;
  const environment = payload.environments.find((candidate) => candidate.path === request.workspace);
  const slot = request.slot ?? 'default';
  const devices = slot === 'default' ? environment : environment?.slots?.find((candidate) => candidate.slot === slot);
  if (request.platform === 'ios') {
    const ios = devices?.ios;
    return { appId: ios?.app?.state === 'running' ? (ios.app.id ?? null) : null, model: deviceModel(ios?.name) };
  }
  if (request.platform === 'android') {
    const android = devices?.android;
    return { appId: null, model: androidModel(android?.deviceProfile) };
  }
  return none;
}

export function viewerTitle(platform: keyof typeof PLATFORM_LABEL, app: string | null, model: string | null): string {
  const label = PLATFORM_LABEL[platform] ?? platform;
  return [app ?? `Live ${label} app`, model, 'Stim'].filter(Boolean).join(` ${MIDDOT} `);
}

export function loginTitle(app: string | null): string {
  return `${app ?? 'Shared app'} ${MIDDOT} Stim`;
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: LOOKUP_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout),
    );
  });
}

/** The display name an installed simulator app gives itself, or null when it cannot be read. */
export async function simulatorAppName(
  udid: string,
  bundleId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  const container = (await run('xcrun', ['simctl', 'get_app_container', udid, bundleId, 'app'], env))?.trim();
  if (!container) return null;
  const json = await run('plutil', ['-convert', 'json', '-o', '-', `${container}/Info.plist`], env);
  if (!json) return null;
  try {
    const info: unknown = JSON.parse(json);
    if (typeof info !== 'object' || info === null) return null;
    return (
      cleanTitleText(Reflect.get(info, 'CFBundleDisplayName')) ?? cleanTitleText(Reflect.get(info, 'CFBundleName'))
    );
  } catch {
    return null;
  }
}
