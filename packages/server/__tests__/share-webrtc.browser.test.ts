import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, type Browser, type BrowserType, type LaunchOptions, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { share, type Probe } from './fixtures/share-browser.ts';
import { cleanupRtc } from '../src/webrtc-sender.ts';

/**
 * Real browsers against a share on loopback, with the device replaced by a looping H.264 clip. The sender, the share
 * socket and the viewer scripts are the real ones. `SHARE_BROWSERS` lists the engines (default `chromium`), and
 * `SHARE_BROWSER_CHANNEL` the installed browser Chromium runs as (default `chrome`, which has the H.264 decoder).
 */

const PROBE = fileURLToPath(new URL('./fixtures/share-probe.js', import.meta.url));

const PUBLIC_VIEWER = fileURLToPath(new URL('./fixtures/share-public-viewer.js', import.meta.url));

const probe = (page: Page): Promise<Probe> =>
  page.evaluate<Probe>(
    '(() => { const { draws, socketVideo, peers, log } = window.shareProbe; return { draws, socketVideo, peers, log, phase: document.body.dataset.rtcPhase }; })()',
  );

/** Polls the page's probe until `done` holds. The viewer's CSP forbids the string evaluation `waitForFunction` uses. */
async function until(page: Page, done: (state: Probe) => boolean, timeout: number, what: string): Promise<Probe> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const state = await probe(page);
    if (done(state)) return state;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(state)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const waitForPhase = (page: Page, phase: string, timeout = 30_000): Promise<Probe> =>
  until(page, (state) => state.phase === phase, timeout, `phase ${phase}`);

/** Waits until the page has drawn more frames than `after` and returns the new count. */
async function drawnPast(page: Page, after: number, timeout = 5000): Promise<number> {
  return (await until(page, (state) => state.draws > after, timeout, `${after} draws`)).draws;
}

const engines: Record<string, { type: BrowserType; options: LaunchOptions }> = {
  chromium: {
    type: chromium,
    options: {
      channel: process.env.SHARE_BROWSER_CHANNEL ?? 'chrome',
      args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
    },
  },
  webkit: {
    type: webkit,
    options: process.env.SHARE_WEBKIT_EXECUTABLE ? { executablePath: process.env.SHARE_WEBKIT_EXECUTABLE } : {},
  },
};

for (const name of (process.env.SHARE_BROWSERS ?? 'chromium').split(',')) {
  const engine = engines[name];
  if (!engine) throw new Error(`Unknown browser engine ${name}`);

  describe(`the share viewer in ${name}`, () => {
    let browser: Browser;
    let running: Awaited<ReturnType<typeof share>> | null = null;
    let decodes = true;

    beforeAll(async () => {
      browser = await engine.type.launch({ headless: true, ...engine.options });
      const blank = createServer((_request, response) => response.end('<!doctype html>'));
      await new Promise<void>((resolve) => blank.listen(0, '127.0.0.1', resolve));
      const page = await browser.newPage();
      const address = blank.address();
      if (!address || typeof address === 'string') throw new Error('The probe server has no port.');
      await page.goto(`http://127.0.0.1:${address.port}/`);
      decodes = await page.evaluate<boolean>(
        `(async () => typeof VideoDecoder === 'function' && typeof RTCPeerConnection === 'function' &&
          (await VideoDecoder.isConfigSupported({ codec: 'avc1.4d0028' })).supported === true)()`,
      );
      await page.close();
      blank.close();
      if (!decodes && name === 'chromium' && process.env.CI)
        throw new Error('Chrome cannot decode H.264 on this runner.');
    });
    afterEach(async () => {
      await running?.close();
      running = null;
    });
    afterAll(async () => {
      await browser.close();
      await cleanupRtc();
    });

    async function open(webrtc: boolean, query = ''): Promise<Page> {
      running = await share(webrtc);
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript({ path: PROBE });
      await page.goto(`${running.url}${query}`);
      await until(page, (state) => state.draws > 0, 20_000, 'the first frame');
      return page;
    }

    it('starts on the socket, switches to WebRTC once a keyframe arrives, and returns to the socket when the channel dies', async (context) => {
      if (!decodes) return context.skip();
      const page = await open(true);
      await waitForPhase(page, 'active');
      const active = await probe(page);
      const phases = active.log.map((entry) => entry.phase);
      expect(phases.slice(-4)).toEqual(['ws/idle', 'ws/connecting', 'ws/probing', 'webrtc/active']);
      expect(active.log.find((entry) => entry.phase === 'ws/connecting')?.draws).toBeGreaterThan(0);
      expect(active.log.find((entry) => entry.phase === 'ws/probing')?.draws).toBeGreaterThan(0);

      const drawn = await drawnPast(page, active.draws + 20);
      expect(await page.evaluate<number>("document.querySelectorAll('.rtc-stats').length")).toBe(0);
      const settled = await probe(page);
      expect(settled.socketVideo - active.socketVideo).toBeLessThanOrEqual(5);
      expect(drawn).toBeGreaterThan(active.draws);

      await page.evaluate('window.shareProbe.killPeers()');
      await waitForPhase(page, 'waiting', 15_000);
      const fallen = await probe(page);
      expect(fallen.log.at(-1)?.phase).toBe('ws/waiting');
      await drawnPast(page, fallen.draws + 10);
      expect((await probe(page)).socketVideo).toBeGreaterThan(fallen.socketVideo);
      await page.context().close();
    });

    it('keeps drawing on the socket while a viewer on a public address is refused a data channel', async (context) => {
      if (!decodes) return context.skip();
      running = await share(true);
      const page = await (await browser.newContext()).newPage();
      await page.addInitScript({ path: PROBE });
      await page.addInitScript({ path: PUBLIC_VIEWER });
      await page.goto(running.url);
      const failed = await waitForPhase(page, 'waiting', 20_000);
      expect(failed.peers).toBe(1);
      expect(failed.log.map((entry) => entry.phase)).not.toContain('webrtc/active');
      expect(failed.log.find((entry) => entry.phase === 'ws/connecting')?.draws).toBeGreaterThan(0);
      await drawnPast(page, failed.draws + 20);
      await page.context().close();
    });

    it('never tries WebRTC when the share does not offer it or the page chooses the socket', async (context) => {
      if (!decodes) return context.skip();
      for (const [offered, query] of [
        [false, ''],
        [true, '?transport=ws'],
      ] as const) {
        const page = await open(offered, query);
        const first = await probe(page);
        await drawnPast(page, first.draws + 30);
        const after = await probe(page);
        expect(after.peers).toBe(0);
        expect(after.log.every((entry) => entry.phase.startsWith('ws/'))).toBe(true);
        await page.context().close();
        await running?.close();
        running = null;
      }
    });
  });
}
