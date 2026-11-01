import type { DoctorContext, DoctorPlatform, Finding } from '../diagnostics/doctor.ts';
import type { BuildTarget } from '../offload/toolchain.ts';
import type { StimContext } from '@stim-cli/core';
import type { SettingsObject } from '../workspace/settings.ts';

type RepairResult = { removed: string[]; refused: { path: string; reason: string }[] };

/** Adds read-only project checks to shared findings; only repair runs under doctor --fix. */
export interface ProjectDoctor {
  inspect(context: DoctorContext): Finding[] | Promise<Finding[]>;
  inspectAsync?(context: DoctorContext): Promise<Finding[]>;
  /** Defers toolchain probes until a configured remote build machine is inspected. */
  offloadTargets?(
    context: DoctorContext,
    iosRuntime: () => Promise<string | null>,
  ): (() => Promise<BuildTarget[]>) | null;
  repair?(
    platform: DoctorPlatform | undefined,
    settings: SettingsObject | null,
    repoRoot: string | null,
    operation?: StimContext,
  ): RepairResult | Promise<RepairResult>;
  successLines?(platform: DoctorPlatform | undefined): string[];
}
