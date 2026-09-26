import { inspectProcessIdentity } from '../process-identity.ts';
import { connectOwnedBrowser } from './cdp.ts';
import type { WebRecord } from './state.ts';

/** The record of a verified live browser: its supervisor and Chrome are the processes the record names. */
export function liveWebRecord(record: WebRecord | null): (WebRecord & { targetId: string }) | null {
  if (!record?.targetId || !record.chromeProcess) return null;
  if (inspectProcessIdentity(record) !== 'same' || inspectProcessIdentity(record.chromeProcess) !== 'same') return null;
  return record as WebRecord & { targetId: string };
}

/** Sends one page-level DevTools command to the owned page, through a connection verified to reach its Chrome. */
export async function sendToOwnedPage(
  record: WebRecord & { targetId: string },
  method: string,
  params: Record<string, unknown> = {},
): Promise<void> {
  const cdp = await connectOwnedBrowser(record.cdpPort, record.chromeProcess!.pid);
  try {
    const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId: record.targetId, flatten: true })) as {
      sessionId: string;
    };
    await cdp.send(method, params, sessionId);
  } finally {
    cdp.close();
  }
}
