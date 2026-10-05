import { isJsonObject } from './json-file.ts';
import type { HostedAppDelivery } from './hosted-app.ts';

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
 * Agent control the host grants a client for one installed hosted app, sent only over that client's approved
 * device-host connection and never journaled. `none` means the host's `hosting.agentDriver` starts no driver.
 * `path` is the session's base route on the host, `scope` the driver's handle that limits it to this one app.
 */
export type HostedAgentGrant =
  | { driver: 'none' }
  | { driver: Exclude<HostedAgentDriverName, 'none'>; path: string; token: string; scope: string };

/** `app.launch` and `app.attach` results; a host includes `agent` once the app is installed. */
export type HostedAppLaunch = HostedAppDelivery & { agent?: HostedAgentGrant };

/**
 * Agent control as the client hands it to a coding agent: secrets stay in files Stim writes with mode
 * 0600, and `command` shows how to address the hosted app. Never carries a token inline. `setting` names
 * the hosting Mac's setting that turns a driver on.
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
  /** The host-assigned id the running app uses, `hostedMacosBundleId(<offered id>, appSlot)`. */
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

const AGENT_PATH = /^\/device-host\/agent\/[a-f0-9-]{36}\/$/;

/** A grant naming a driver this client does not know is not usable; it parses as null. */
export function parseHostedAgentGrant(value: unknown): HostedAgentGrant | null {
  if (!isJsonObject(value)) return null;
  if (value.driver === 'none') return Object.keys(value).length === 1 ? { driver: 'none' } : null;
  if (
    !HOSTED_AGENT_DRIVERS.includes(value.driver as HostedAgentDriverName) ||
    typeof value.path !== 'string' ||
    !AGENT_PATH.test(value.path) ||
    typeof value.token !== 'string' ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(value.token) ||
    typeof value.scope !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(value.scope) ||
    Object.keys(value).length !== 4
  )
    return null;
  return {
    driver: value.driver as Exclude<HostedAgentDriverName, 'none'>,
    path: value.path,
    token: value.token,
    scope: value.scope,
  };
}

function parseHostedAgentAccess(value: unknown): HostedAgentAccess | null {
  if (!isJsonObject(value)) return null;
  if (value.driver === 'none')
    return value.setting === 'hosting.agentDriver' && Object.keys(value).length === 2
      ? { driver: 'none', setting: 'hosting.agentDriver' }
      : null;
  if (
    value.driver !== 'agent-device' ||
    typeof value.remoteConfig !== 'string' ||
    !value.remoteConfig.startsWith('/') ||
    typeof value.command !== 'string' ||
    !value.command ||
    Object.keys(value).length !== 3
  )
    return null;
  return { driver: 'agent-device', remoteConfig: value.remoteConfig, command: value.command };
}

export function parseHostedMacosPlacement(value: unknown): HostedMacosPlacement | null {
  if (
    !isJsonObject(value) ||
    typeof value.machine !== 'string' ||
    !value.machine ||
    typeof value.session !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.session) ||
    !hostedMacosAppSlot(value.appSlot) ||
    typeof value.appAttempt !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(value.appAttempt) ||
    typeof value.bundleId !== 'string' ||
    !value.bundleId.endsWith(`.hosted${value.appSlot}`)
  )
    return null;
  const agent = parseHostedAgentAccess(value.agent);
  if (!agent) return null;
  return {
    machine: value.machine,
    session: value.session,
    appSlot: value.appSlot,
    appAttempt: value.appAttempt,
    bundleId: value.bundleId,
    agent,
  };
}
