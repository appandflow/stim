'use strict';

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const MISSING_RETRY_MS = 30000;
const MISSING_GIVE_UP_MS = 10 * 60 * 1000;

/** How long to wait before retry number `attempt` (0 for the first): 1 s, doubling, at most 15 s. */
function reconnectDelay(attempt) {
  return Math.min(RECONNECT_MIN_MS * 2 ** attempt, RECONNECT_MAX_MS);
}

/**
 * What a GET of the share link says about getting back in: the viewer page when the session is still valid (or the
 * share needs no login), the login page when the server no longer knows the session, a 404 when it does not know the
 * link, and anything else (a proxy's 502, a rate limit) as a reason to try again.
 */
function probeVerdict(status, html) {
  if (status === 404) return 'missing';
  if (status !== 200) return 'retry';
  return /<body[^>]*\bclass="viewer"/.test(html) ? 'viewer' : 'login';
}

globalThis.stimReconnect = { reconnectDelay, probeVerdict, MISSING_RETRY_MS, MISSING_GIVE_UP_MS };
