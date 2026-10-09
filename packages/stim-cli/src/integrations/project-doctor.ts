import type { DoctorContext, DoctorPlatform, Finding } from '../diagnostics/doctor.ts';
import type { BuildTarget } from '../offload/toolchain.ts';

/** Adds read-only project checks to shared findings; only repair runs under doctor --fix. */
export interface ProjectDoctor {
  inspect(context: DoctorContext): Finding[];
  inspectAsync?(context: DoctorContext): Promise<Finding[]>;
  /** Defers toolchain probes until a configured remote build machine is inspected. */
  offloadTargets?(context: DoctorContext, iosRuntime: () => string | null): (() => BuildTarget[]) | null;
  repair?(platform: DoctorPlatform | undefined): { removed: string[]; refused: { path: string; reason: string }[] };
  successLines?(platform: DoctorPlatform | undefined): string[];
}
