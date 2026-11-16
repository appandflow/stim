type ReportChildLog = (level: 'info', event: string, msg: string, fields: Record<string, unknown>) => void;

let sink: ReportChildLog | undefined;

/** Routes the records about a refused report child to the daemon log. Only stimd and its threads set it. */
export function setReportChildLog(log: ReportChildLog | undefined): void {
  sink = log;
}

export function logReportChild(msg: string, fields: Record<string, unknown>): void {
  try {
    sink?.('info', 'daemon_report_child_exited', msg, fields);
  } catch {}
}
