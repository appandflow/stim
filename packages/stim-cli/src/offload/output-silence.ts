import { formatElapsed } from '../command-output.ts';

/** How long an offloaded build may print no build output before its heartbeat line says so. */
export const OUTPUT_SILENCE_MS: number = 5 * 60_000;

const MAX_LINE_CHARS = 160;

/** The text of a relayed build log record, on one line and bounded, or null when it carries none. */
export function outputLine(record: Record<string, unknown>): string | null {
  if (typeof record.msg !== 'string') return null;
  const line = record.msg.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line;
}

/** Whether a relayed phase line is a heartbeat, such as `still compiling (3m00s)`, which says only that time passed. */
export function heartbeatPhase(phase: string, msg: string): boolean {
  const text = msg.trim();
  return (text.startsWith(`${phase} `) ? text.slice(phase.length).trimStart() : text).startsWith('still ');
}

export function silenceText(silentMs: number, last: string | null = null): string {
  const silent = `no build output for ${formatElapsed(silentMs)}`;
  return last === null ? silent : `${silent}, last line: ${JSON.stringify(last)}`;
}
