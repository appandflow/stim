import type { BuildPlanPayload } from '@stim-cli/core/state';

export interface PlanRefusal {
  code: string;
  message: string;
  remedy: string;
}

export type ProjectPlanResult = BuildPlanPayload | { refusal: PlanRefusal; lines?: string[] };

export function unsupportedPlan(platform: 'ios' | 'android'): PlanRefusal {
  return {
    code: 'STIM_BAD_ARG',
    message: `This project's ${platform} integration does not provide a read-only build plan.`,
    remedy: `Run \`stim ${platform}\` without --plan to build and run the app.`,
  };
}

export function fingerprintPlanRefusal(
  root: string,
  failure: { uncertain: string; remedy?: string; stderrTail?: string[] } | null,
): ProjectPlanResult {
  return {
    refusal: {
      code: 'STIM_NO_FINGERPRINT',
      message: failure ? `Could not fingerprint ${root}: ${failure.uncertain}` : `Could not fingerprint ${root}.`,
      remedy: failure?.remedy ?? 'Check the project native inputs and retry.',
    },
    lines: failure?.stderrTail ?? [],
  };
}
