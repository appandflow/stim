import { inspectProcessIdentity } from '../process-identity.ts';
import { connectOwnedBrowser } from './cdp.ts';
import type { WebRecord } from './state.ts';

/** The record of a verified live browser: its supervisor and Chrome are the processes the record names. */
export function liveWebRecord(record: WebRecord | null): (WebRecord & { targetId: string }) | null {
  if (!record?.targetId || !record.chromeProcess) return null;
  if (inspectProcessIdentity(record) !== 'same' || inspectProcessIdentity(record.chromeProcess) !== 'same') return null;
  return record as WebRecord & { targetId: string };
}

// Chrome answers Page.navigate only once the response arrives, and a cold dev server can take longer than any
// sensible wait; the owned supervisor observes the load either way.
const NAVIGATE_ACK_MS = 1000;

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
    const reply = cdp.send(method, params, sessionId);
    if (method === 'Page.navigate') {
      reply.catch(() => {});
      await Promise.race([reply, new Promise((resolve) => setTimeout(resolve, NAVIGATE_ACK_MS))]);
    } else {
      await reply;
    }
  } finally {
    cdp.close();
  }
}
