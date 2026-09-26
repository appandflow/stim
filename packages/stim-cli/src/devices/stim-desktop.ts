import { getExecutor } from '../exec.ts';
import type { SettingDefinition } from '@stim-cli/core/state';

const STIM_DESKTOP_BUNDLE_ID = 'dev.stim.desktop';

const LAUNCH_SERVICES_LOOKUP = `ObjC.import('AppKit'); const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier('${STIM_DESKTOP_BUNDLE_ID}'); url.isNil() ? '' : url.path.js`;

export const STIM_DESKTOP_INSTALLED = 'Stim Desktop installed';

export function stimDesktopInstalled(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'darwin') return false;
  const found = getExecutor().runFileQuiet('osascript', ['-l', 'JavaScript', '-e', LAUNCH_SERVICES_LOOKUP], {
    timeoutMs: 5000,
    killSignal: 'SIGKILL',
  });
  return Boolean(found);
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
