type ReportChildLog = (level: 'info' | 'warn', event: string, msg: string, fields: Record<string, unknown>) => void;

let sink: ReportChildLog | undefined;

/** Routes the records about a refused or left report child to the daemon log. Only stimd and its threads set it. */
export function setReportChildLog(log: ReportChildLog | undefined): void {
  sink = log;
}

export function logReportChild(
  msg: string,
  fields: Record<string, unknown>,
  event = 'daemon_report_child_exited',
  level: 'info' | 'warn' = 'info',
): void {
  try {
    sink?.(level, event, msg, fields);
  } catch {}
}
