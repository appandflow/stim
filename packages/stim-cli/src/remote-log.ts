type Sink = (record: Record<string, unknown>) => void;

let sink: Sink | null = null;

/** Where this run's failed requests to another Mac are written: its workspace log, so `stim logs` shows them. */
export function setRemoteLogSink(next: Sink | null): void {
  sink = next;
}

export function reportRemoteFailure(event: string, fields: Record<string, unknown>): void {
  try {
    sink?.({ src: 'build', level: 'warn', event, ...fields });
  } catch {}
}
