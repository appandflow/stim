import type { NdjsonRecord } from '../ndjson.ts';

export type WebLaunched = true | 'bundling' | 'unverified';

type WebLaunchKind = 'loaded' | 'bundling' | 'document-failed' | 'no-bundle' | 'loading' | 'no-response';

export interface WebLaunchVerdict {
  launched: WebLaunched;
  kind: WebLaunchKind;
  reason: string | null;
}

const VERIFY_WAIT_MS = 20_000;
const LOADING_WAIT_MS = 60_000;

const METRO_WEB_BUNDLE = /\bWeb\s+Bundl(?:ing|ed)\b/i;

function after(record: NdjsonRecord, since: number): boolean {
  const ts = Number(record.ts);
  return Number.isFinite(ts) && ts >= since;
}

/**
 * Decides `launched` for a `stim web` navigation from the owned page's evidence since `since`: `true` needs the
 * page's load event after a successful document response and, for Metro, a web bundle response. A failed
 * document is decided at once. The check ends after 20 seconds, or 60 once a document not served by Metro has
 * answered; until then it returns null while the evidence is incomplete.
 */
export function webLaunchVerdict({
  records,
  metroRecords = [],
  since,
  expectBundle,
  elapsedMs,
}: {
  records: readonly NdjsonRecord[];
  metroRecords?: readonly NdjsonRecord[];
  since: number;
  expectBundle: boolean;
  elapsedMs: number;
}): WebLaunchVerdict | null {
  const recent = records.filter((record) => after(record, since));
  const failed = recent.find((record) => record.event === 'web_document_failed');
  if (failed) {
    return { launched: 'unverified', kind: 'document-failed', reason: String(failed.msg ?? 'the page did not load') };
  }
  const documentLoaded = recent.some(
    (record) => record.event === 'web_document_response' && Number(record.status) < 400,
  );
  const pageLoaded = recent.some((record) => record.event === 'web_page_loaded');
  const bundled = recent.some((record) => record.event === 'web_bundle_response' && Number(record.status) < 400);
  if (documentLoaded && pageLoaded && (!expectBundle || bundled))
    return { launched: true, kind: 'loaded', reason: null };
  if (documentLoaded && pageLoaded) {
    return {
      launched: 'unverified',
      kind: 'no-bundle',
      reason: 'the page loaded without requesting a web bundle from Metro',
    };
  }
  const waitMs = documentLoaded && !expectBundle ? LOADING_WAIT_MS : VERIFY_WAIT_MS;
  if (elapsedMs < waitMs) return null;
  const bundling =
    expectBundle &&
    documentLoaded &&
    metroRecords.some((record) => after(record, since) && METRO_WEB_BUNDLE.test(String(record.msg ?? '')));
  if (bundling) return { launched: 'bundling', kind: 'bundling', reason: 'Metro was still building the web bundle' };
  return documentLoaded
    ? {
        launched: 'unverified',
        kind: 'loading',
        reason: `the server answered, but the page did not fire its load event within ${waitMs / 1000} seconds`,
      }
    : { launched: 'unverified', kind: 'no-response', reason: 'the page never received a response' };
}

const RETRY = 'then run `stim web` again';

export function webLaunchRemedy(
  verdict: WebLaunchVerdict,
  { url, usesMetro }: { url: string; usesMetro: boolean },
): string | null {
  const https = url.startsWith('https:');
  const reason = verdict.reason ?? '';
  switch (verdict.kind) {
    case 'loaded':
      return null;
    case 'bundling':
      return 'Metro is still building the web bundle. Run `stim logs --errors` in a moment to confirm the page rendered.';
    case 'loading':
      return `A cold dev server can take longer on its first load. Read \`stim logs --errors\`, ${RETRY}.`;
    case 'document-failed':
      if (https && /net::ERR_CERT_/.test(reason)) {
        return `The dev server's certificate is not trusted, as with a self-signed development certificate. Accept it in the owned profile only: \`stim settings set web.ignoreCertificateErrors true --scope workspace\`, ${RETRY}.`;
      }
      if (https && /net::ERR_SSL_PROTOCOL_ERROR/.test(reason)) {
        return `The server on that port did not answer HTTPS. If it serves plain HTTP, set web.url with http:// (\`stim settings set web.url <url> --scope workspace\`), ${RETRY}.`;
      }
      if (!https && /net::ERR_EMPTY_RESPONSE/.test(reason)) {
        return `The server on that port closed the connection without an HTTP answer. If it serves HTTPS, set web.url with https:// (\`stim settings set web.url <url> --scope workspace\`), ${RETRY}.`;
      }
      if (/failed: HTTP \d+/.test(reason)) {
        return `The server answered, but not with the page. Check web.url's path, including the app's base path, ${RETRY}.`;
      }
      break;
    case 'no-bundle':
    case 'no-response':
      break;
  }
  return usesMetro
    ? `Run \`stim logs --errors\`; Metro may have failed to build the web bundle for ${url}.`
    : `Nothing served ${url}. Start the web dev server on that port, for example \`pnpm exec vite --port "$(stim ports get web)" --strictPort\`, ${RETRY}.`;
}
