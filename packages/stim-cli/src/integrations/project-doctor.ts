import type { DoctorContext, DoctorPlatform, Finding } from '../diagnostics/doctor.ts';
import type { BuildTarget } from '../offload/toolchain.ts';
import type { SettingsObject } from '../workspace/settings.ts';

/** Adds read-only project checks to shared findings; only repair runs under doctor --fix. */
export interface ProjectDoctor {
  inspect(context: DoctorContext): Finding[];
  inspectAsync?(context: DoctorContext): Promise<Finding[]>;
  /** Defers toolchain probes until a configured remote build machine is inspected. */
  offloadTargets?(
    context: DoctorContext,
    iosRuntime: () => Promise<string | null>,
  ): (() => Promise<BuildTarget[]>) | null;
  repair?(
    platform: DoctorPlatform | undefined,
    settings: SettingsObject | null,
  ): { removed: string[]; refused: { path: string; reason: string }[] };
  successLines?(platform: DoctorPlatform | undefined): string[];
}
