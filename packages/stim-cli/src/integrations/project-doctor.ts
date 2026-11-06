import type { DoctorContext, DoctorPlatform, Finding } from '../diagnostics/doctor.ts';
import type { BuildTarget } from '../engine/toolchain.ts';
import type { StimContext } from '@stim-cli/core';
import type { SettingsObject } from '../workspace/settings.ts';

type RepairResult = { removed: string[]; refused: { path: string; reason: string }[] };

interface SourceRepairRequest {
  platform: DoctorPlatform | undefined;
  settings: SettingsObject | null;
  host: NodeJS.Platform;
  operation: StimContext;
  confirm: ((question: string) => Promise<boolean>) | null;
  note: (line: string) => void;
}

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
  repairSource?(request: SourceRepairRequest): Promise<0 | 1>;
  successLines?(platform: DoctorPlatform | undefined): string[];
}
