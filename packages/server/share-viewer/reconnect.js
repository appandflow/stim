'use strict';

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const MISSING_RETRY_MS = 30000;
const MISSING_GIVE_UP_MS = 10 * 60 * 1000;

function reconnectDelay(attempt) {
  return Math.min(RECONNECT_MIN_MS * 2 ** attempt, RECONNECT_MAX_MS);
}

function probeVerdict(status, html) {
  if (status === 404) return 'missing';
  if (status !== 200) return 'retry';
  if (/<body[^>]*\bclass="viewer"/.test(html)) return 'viewer';
  return /<form[^>]*\baction="login"/.test(html) ? 'login' : 'retry';
}

globalThis.stimReconnect = { reconnectDelay, probeVerdict, MISSING_RETRY_MS, MISSING_GIVE_UP_MS };
