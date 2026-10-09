import type { RuntimePlan } from '../engine/runtime-plan.ts';
import type { WebLaunchVerdict } from '../web/launch.ts';
import type { WebLaunchConfig, WebRecord } from '../web/state.ts';
import type { SettingsObject } from '../workspace/settings.ts';

export interface WebFailure {
  code: string;
  message: string;
  remedy: string | null;
}

export interface WebRuntimePreparation {
  url: string;
  config: WebLaunchConfig;
  metroPort: number | null;
  verification: {
    template: string | null;
    expectBundle: boolean;
    serve: string | null;
    foreign: { reason: string; remedy: string } | null;
  };
}

export interface WebRuntimeContext {
  root: string;
  note: (line: string) => void;
}

export type WebLaunchResult =
  | { ok: true; record: WebRecord; since: number; reused: boolean }
  | { ok: false; error: WebFailure };

type WebRuntimePlan = RuntimePlan<
  WebRuntimePreparation,
  WebRuntimeContext,
  WebLaunchResult,
  { since: number },
  { verdict: WebLaunchVerdict; remedy: string | null }
>;

export interface WebProject {
  runtime(options: { settings: SettingsObject; headed: boolean; note: (line: string) => void }): WebRuntimePlan;
}
