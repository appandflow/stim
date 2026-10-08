export interface RuntimePreparationError {
  code: string;
  message: string;
  remedy?: string | null;
  lines?: string[];
}

export type RuntimePreparationResult<Prepared> =
  | { ok: true; prepared: Prepared }
  | { ok: false; error: RuntimePreparationError };

export interface RuntimePlan<Prepared, LaunchContext, Launched, VerifyContext, Verified> {
  prepare(): Promise<RuntimePreparationResult<Prepared>>;
  launch(prepared: Prepared, context: LaunchContext): Promise<Launched>;
  verify(prepared: Prepared, context: VerifyContext): Promise<Verified>;
}
