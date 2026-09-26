import type { HomeView } from '@/hooks/home-filters';
import type { VideoQuality } from '@/hooks/settings';
import type { Appearance } from '@/theme';

export interface Option<T extends string> {
  value: T;
  label: string;
}

export const APPEARANCE_OPTIONS: Option<Appearance>[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export const HOME_VIEW_OPTIONS: Option<HomeView>[] = [
  { value: 'workspaces', label: 'Workspaces' },
  { value: 'devices', label: 'Devices' },
  { value: 'machines', label: 'Machines' },
];

export const VIDEO_QUALITY_OPTIONS: Option<VideoQuality>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'high', label: 'High' },
  { value: 'dataSaver', label: 'Data saver' },
];

export const labelOf = <T extends string>(options: Option<T>[], value: T): string =>
  options.find((option) => option.value === value)?.label ?? options[0].label;

export const HOME_FOOTER = 'Home opens on this view. Idle workspaces are those with nothing running.';

export const VIDEO_QUALITY_FOOTER =
  "Auto matches this phone's screen, up to 1600 pixels. High always asks for 1600 pixels. Both stream video at up to 60 fps. Data saver sends still frames at up to 10 fps and 640 pixels.";

export const READ_ONLY_FOOTER =
  "A read-only machine shows its status but can't run actions or control devices from this phone. Tap it to see how to allow control.";
