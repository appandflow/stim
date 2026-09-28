import { getExecutor } from '../exec.ts';
import type { SettingDefinition } from '@stim-cli/core/state';

const STIM_DESKTOP_BUNDLE_ID = 'dev.stim.desktop';

const LAUNCH_SERVICES_LOOKUP = `ObjC.import('AppKit'); const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier('${STIM_DESKTOP_BUNDLE_ID}'); url.isNil() ? '' : url.path.js`;

const SCHEME_HANDLER_LOOKUP = `ObjC.import('AppKit'); const url = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString('stim-desktop://workspace')); url.isNil() ? '' : url.path.js`;

export const STIM_DESKTOP_INSTALLED = 'Stim Desktop installed';

/**
 * macOS `open` passes its environment to an app it launches, so Stim Desktop
 * started by a command run under a scoped `STIM_HOME` would serve that home.
 */
export const STIM_DESKTOP_OPEN_OPTIONS = {
  timeoutMs: 5000,
  killSignal: 'SIGKILL',
  omitEnv: ['STIM_HOME'],
} as const;

/** Stim Desktop sets `STIM_DESKTOP_APP` to its bundle path for every command it runs; a non-empty value means Desktop is installed. */
export function stimDesktopInstalled(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform !== 'darwin') return false;
  if (env.STIM_DESKTOP_APP) return true;
  return launchServicesFinds(LAUNCH_SERVICES_LOOKUP);
}

function launchServicesFinds(script: string): boolean {
  return Boolean(
    getExecutor().runFileQuiet('osascript', ['-l', 'JavaScript', '-e', script], {
      timeoutMs: 5000,
      killSignal: 'SIGKILL',
    }),
  );
}

export interface WorkspaceLinks {
  desktop: string;
}

function stimDesktopHandlesLinks(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env) {
  if (platform !== 'darwin') return false;
  if (env.STIM_DESKTOP_APP) return true;
  return launchServicesFinds(SCHEME_HANDLER_LOOKUP);
}

/**
 * The links that open this workspace for a human, or undefined when no app on this Mac handles
 * `stim-desktop://`. `target` names the device Stim Desktop focuses when the user opens the workspace.
 */
export function workspaceLinks(
  root: string,
  target?: { platform: 'ios' | 'android' | 'web'; slot?: string },
  handlesLinks: () => boolean = stimDesktopHandlesLinks,
): WorkspaceLinks | undefined {
  if (!handlesLinks()) return undefined;
  let desktop = `stim-desktop://workspace?path=${linkParam(root)}`;
  if (target) desktop += `&platform=${target.platform}`;
  if (target?.slot && target.slot !== 'default') desktop += `&slot=${linkParam(target.slot)}`;
  return { desktop };
}

const linkParam = (value: string) => encodeURIComponent(value).replaceAll('%2F', '/');

export function workspaceLinkLine(links: WorkspaceLinks): string {
  return `Open in Stim Desktop: ${links.desktop}`;
}

export function settingDefault(
  setting: SettingDefinition,
  desktopInstalled: () => boolean = stimDesktopInstalled,
): { value: SettingDefinition['default']; reason: string | null } {
  if (setting.desktopDefault !== undefined && desktopInstalled()) {
    return { value: setting.desktopDefault, reason: STIM_DESKTOP_INSTALLED };
  }
  return { value: setting.default, reason: null };
}
