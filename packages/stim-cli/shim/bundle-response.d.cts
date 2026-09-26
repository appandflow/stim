import type { IncomingMessage, ServerResponse } from 'node:http';

export function bundleResponseMiddleware(
  write: (record: Record<string, unknown>) => unknown,
  options?: { runLsof?: (args: string[]) => Promise<string> },
): (req: IncomingMessage, res: ServerResponse, next: () => unknown) => unknown;
