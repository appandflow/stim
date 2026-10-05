import { isJsonObject } from './json-file.ts';

/** App slots one host offers; a slot names the host-assigned bundle id `<bundleId>.hosted<slot>`. */
export const HOSTED_MACOS_APP_SLOTS = 64;

export const HOSTED_AGENT_DRIVERS = ['none', 'agent-device'] as const;

export type HostedAgentDriverName = (typeof HOSTED_AGENT_DRIVERS)[number];

/** What a host reports in a macOS offer: no simulator is created, so the choice is the host itself. */
export interface HostedMacosChoice {
  architecture: 'arm64' | 'x86_64';
  macosVersion: string;
}

/** A ready hosted macOS session's identity: the host it runs on and the app slot reserved for it. */
export interface HostedMacosDevice extends HostedMacosChoice {
  appSlot: number;
}

/**
 * Agent control the host grants a client for one hosted app, sent only over that client's approved
 * device-host connection. `none` means the host's `hosting.agentDriver` starts no driver.
 */
export type HostedAgentGrant =
  | { driver: 'none' }
  | { driver: 'agent-device'; path: string; token: string; leaseId: string };

/**
 * Agent control as the client hands it to a coding agent: secrets stay in files Stim writes with mode
 * 0600, and `command` shows how to address the hosted app. Never carries a token inline.
 */
export type HostedAgentAccess =
  | { driver: 'none'; setting: 'hosting.agentDriver' }
  | { driver: 'agent-device'; remoteConfig: string; command: string };

/** Where a workspace's macOS app runs when `stim macos --host` placed it on another Mac. */
export interface HostedMacosPlacement {
  machine: string;
  session: string;
  appSlot: number;
  appAttempt: string;
  bundleId: string;
  agent: HostedAgentAccess;
}

export function hostedMacosAppSlot(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= HOSTED_MACOS_APP_SLOTS;
}

export function hostedMacosBundleId(bundleId: string, appSlot: number): string {
  return `${bundleId}.hosted${appSlot}`;
}

export function parseHostedMacosChoice(value: unknown): HostedMacosChoice | null {
  if (
    !isJsonObject(value) ||
    (value.architecture !== 'arm64' && value.architecture !== 'x86_64') ||
    typeof value.macosVersion !== 'string' ||
    !/^\d+(\.\d+){0,2}$/.test(value.macosVersion)
  )
    return null;
  return { architecture: value.architecture, macosVersion: value.macosVersion };
}

export function parseHostedMacosDevice(value: unknown): HostedMacosDevice | null {
  if (
    !isJsonObject(value) ||
    !parseHostedMacosChoice(value) ||
    !hostedMacosAppSlot(value.appSlot) ||
    Object.keys(value).some((key) => !['architecture', 'macosVersion', 'appSlot'].includes(key))
  )
    return null;
  return value as unknown as HostedMacosDevice;
}
