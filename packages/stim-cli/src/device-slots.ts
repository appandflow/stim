import type { DeviceRecord, PlatformRecords, ProjectRecord } from './types.ts';

const DEFAULT_DEVICE_SLOT = 'default';

export function validateDeviceSlot(slot: string = 'default'): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(slot) || ['constructor', 'prototype', '__proto__'].includes(slot)) {
    const error = new Error(
      'A device slot must be 1-64 letters, digits, underscores or hyphens, starting with a letter or digit.',
    );
    Object.assign(error, { code: 'STIM_BAD_ARG' });
    throw error;
  }
  return slot;
}

export function deviceSlotPlatforms(
  project: ProjectRecord | null | undefined,
  slot: string = DEFAULT_DEVICE_SLOT,
): PlatformRecords | undefined {
  validateDeviceSlot(slot);
  if (slot === DEFAULT_DEVICE_SLOT) return project?.platforms;
  return project?.deviceSlots && Object.hasOwn(project.deviceSlots, slot) ? project.deviceSlots[slot] : undefined;
}

export function projectDeviceSlots(
  project: ProjectRecord | null | undefined,
): { slot: string; platforms: PlatformRecords }[] {
  const slots = [{ slot: DEFAULT_DEVICE_SLOT, platforms: project?.platforms ?? {} }];
  for (const [slot, platforms] of Object.entries(project?.deviceSlots ?? {})) {
    validateDeviceSlot(slot);
    if (slot === DEFAULT_DEVICE_SLOT)
      throw new Error('The default device slot must use the existing platforms record.');
    if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms))
      throw new Error(`Invalid device slot record: ${slot}`);
    slots.push({ slot, platforms });
  }
  return slots;
}

export function assignSlotDevice(
  project: ProjectRecord,
  platform: string,
  device: DeviceRecord,
  slot: string = DEFAULT_DEVICE_SLOT,
): void {
  validateDeviceSlot(slot);
  if (platform !== 'ios' && platform !== 'android') throw new Error(`Unknown device platform: ${platform}`);
  if (slot === DEFAULT_DEVICE_SLOT) {
    project.platforms = { ...project.platforms, [platform]: device };
  } else {
    project.deviceSlots = {
      ...project.deviceSlots,
      [slot]: { ...deviceSlotPlatforms(project, slot), [platform]: device },
    };
  }
}

export function removeSlotDevice(project: ProjectRecord, platform: string, slot: string = DEFAULT_DEVICE_SLOT): void {
  const platforms = deviceSlotPlatforms(project, slot);
  if (!platforms) return;
  delete platforms[platform];
  if (slot !== DEFAULT_DEVICE_SLOT && Object.keys(platforms).length === 0) {
    delete project.deviceSlots![slot];
    if (Object.keys(project.deviceSlots!).length === 0) delete project.deviceSlots;
  }
}

export function deviceSlotKey(platform: string, slot = 'default'): string {
  validateDeviceSlot(slot);
  if (platform !== 'ios' && platform !== 'android') throw new Error(`Unknown device platform: ${platform}`);
  return slot === 'default' ? platform : `${platform}:${slot}`;
}

export function parseDeviceSlotKey(key: string): { platform: 'ios' | 'android'; slot: string } | null {
  const [platform, slot = 'default', extra] = key.split(':');
  if ((platform !== 'ios' && platform !== 'android') || extra !== undefined) return null;
  try {
    validateDeviceSlot(slot);
  } catch {
    return null;
  }
  if (key !== deviceSlotKey(platform, slot)) return null;
  return { platform, slot };
}
