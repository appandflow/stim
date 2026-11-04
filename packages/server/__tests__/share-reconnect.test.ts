import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { endedPage, loginPage, viewerPage } from '../src/share-page.ts';

interface Reconnect {
  reconnectDelay: (attempt: number) => number;
  probeVerdict: (status: number, html: string) => 'viewer' | 'login' | 'missing' | 'retry';
}

const reconnect: Reconnect = runInNewContext(
  `${readFileSync(new URL('../share-viewer/reconnect.js', import.meta.url), 'utf8')}\nglobalThis.stimReconnect`,
  {},
);

describe('the viewer reconnect', () => {
  it('waits a second, doubles, and never waits more than 15 seconds', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(reconnect.reconnectDelay)).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });

  it('reads the pages the server answers a link with: the viewer, the login, the not-found page', () => {
    const viewer = viewerPage({
      title: 'App',
      control: true,
      viewOnly: false,
      upgrade: false,
      askName: false,
      platform: 'ios',
      buttons: [],
      rotate: false,
    });
    expect(reconnect.probeVerdict(200, viewer)).toBe('viewer');
    expect(reconnect.probeVerdict(200, loginPage(null, null))).toBe('login');
    expect(reconnect.probeVerdict(404, endedPage())).toBe('missing');
  });

  it('retries on a proxy or rate-limit answer instead of treating it as the share being gone', () => {
    for (const status of [429, 502, 503, 504]) expect(reconnect.probeVerdict(status, '')).toBe('retry');
  });
});
