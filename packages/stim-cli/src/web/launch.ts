import type { NdjsonRecord } from '../ndjson.ts';

export type WebLaunched = true | 'bundling' | 'unverified';

export interface WebLaunchVerdict {
  launched: WebLaunched;
  reason: string | null;
}

const METRO_WEB_BUNDLE = /\bWeb\s+Bundl(?:ing|ed)\b/i;

function after(record: NdjsonRecord, since: number): boolean {
  const ts = Number(record.ts);
  return Number.isFinite(ts) && ts >= since;
}

/**
 * Decides `launched` for a `stim web` navigation from the owned page's evidence since `since`: `true` needs the
 * page's load event after a successful document response and, for Metro, a web bundle response. A failed
 * document is decided at once. Returns null while the evidence is still incomplete and `final` is false.
 */
export function webLaunchVerdict({
  records,
  metroRecords = [],
  since,
  expectBundle,
  final,
}: {
  records: readonly NdjsonRecord[];
  metroRecords?: readonly NdjsonRecord[];
  since: number;
  expectBundle: boolean;
  final: boolean;
}): WebLaunchVerdict | null {
  const recent = records.filter((record) => after(record, since));
  const failed = recent.find((record) => record.event === 'web_document_failed');
  if (failed) return { launched: 'unverified', reason: String(failed.msg ?? 'the page did not load') };
  const documentLoaded = recent.some(
    (record) => record.event === 'web_document_response' && Number(record.status) < 400,
  );
  const pageLoaded = recent.some((record) => record.event === 'web_page_loaded');
  const bundled = recent.some((record) => record.event === 'web_bundle_response' && Number(record.status) < 400);
  if (documentLoaded && pageLoaded && (!expectBundle || bundled)) return { launched: true, reason: null };
  if (documentLoaded && pageLoaded) {
    return { launched: 'unverified', reason: 'the page loaded without requesting a web bundle from Metro' };
  }
  if (!final) return null;
  const bundling =
    expectBundle &&
    documentLoaded &&
    metroRecords.some((record) => after(record, since) && METRO_WEB_BUNDLE.test(String(record.msg ?? '')));
  if (bundling) return { launched: 'bundling', reason: 'Metro was still building the web bundle' };
  return {
    launched: 'unverified',
    reason: documentLoaded ? 'the page did not finish loading' : 'the page never received a response',
  };
}
