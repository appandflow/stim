import assert from 'node:assert';
import { createServer, type Server } from 'node:http';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWeb } from '../commands/web.ts';
import { teardownOwnedBrowser } from '../devices/teardown.ts';
import { readNdjsonGenerations } from '../ndjson.ts';
import { inspectProcessIdentity } from '../process-identity.ts';
import { findChrome } from '../web/chrome.ts';
import { runReload } from '../commands/reload.ts';
import { liveWebRecord } from '../web/page.ts';
import { readWebRecord, webLogFile } from '../web/state.ts';
import { setProjectSetting, upsertProject } from '../workspace/config.ts';

const PAGE = `<!doctype html><title>stim web compat</title><body>ok<script>
console.error('compat console error', { answer: 42 });
setTimeout(() => { throw new Error('compat uncaught'); }, 20);
</script>`;

let home: string;
let root: string;
let server: Server;
let port: number;

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-web-compat-')));
  root = join(home, 'app');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'web-compat' }));
  process.env.STIM_HOME = join(home, 'stim');
  server = createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(PAGE);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  port = address.port;
});

afterEach(async () => {
  await teardownOwnedBrowser(root, { deleteProfile: true });
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('real Chrome accepts the owned-profile argv, reports page logs and launched, reloads, and tears down', async () => {
  const chrome = findChrome();
  assert(chrome, 'No Chrome or Chromium is installed; the web compatibility stage needs one.');
  upsertProject(root, {});
  setProjectSetting(root, 'web.url', `http://127.0.0.1:${port}/`);
  const notes: string[] = [];
  const result = await runWeb({ root, headed: false, note: (line) => notes.push(line) });
  assert(result.ok, `stim web failed: ${JSON.stringify(result)} ${notes.join('\n')}`);
  expect(result.facts).toMatchObject({ launched: true, headless: true, url: `http://127.0.0.1:${port}/` });

  const record = liveWebRecord(readWebRecord(root));
  assert(record, 'the owned Chrome is not verified live after stim web');
  expect(record.profile.startsWith(process.env.STIM_HOME!)).toBe(true);

  const deadline = Date.now() + 5000;
  const records = () => readNdjsonGenerations(webLogFile(root));
  while (!records().some((entry) => entry.event === 'web_exception') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(records()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ src: 'client', level: 'error', msg: 'compat console error {answer: 42}' }),
      expect.objectContaining({ src: 'client', event: 'web_exception', msg: 'Uncaught Error: compat uncaught' }),
      expect.objectContaining({ event: 'web_request_failed', status: 404 }),
    ]),
  );

  const loads = records().filter((entry) => entry.event === 'web_page_loaded').length;
  expect(await runReload({ root, platform: 'web' })).toMatchObject({ ok: true, facts: { strategy: 'cdp' } });
  const reloadDeadline = Date.now() + 5000;
  while (records().filter((entry) => entry.event === 'web_page_loaded').length === loads) {
    assert(Date.now() < reloadDeadline, 'Page.reload produced no load event');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  expect((await teardownOwnedBrowser(root)).status).toBe('torn-down');
  expect(inspectProcessIdentity(record.chromeProcess)).not.toBe('same');
  expect(inspectProcessIdentity(record)).not.toBe('same');
  expect(() => lstatSync(join(record.profile, 'SingletonLock'))).toThrow(/ENOENT/);
  expect(lstatSync(record.profile).isDirectory()).toBe(true);
}, 60_000);
