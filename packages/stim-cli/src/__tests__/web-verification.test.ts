import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserWebProject } from '../integrations/browser-web.ts';
import { webLogFile } from '../web/state.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { testContext } from './_context.ts';

const follower = vi.hoisted(() => ({ changed: () => {}, initialHint: false, stop: vi.fn<() => void>() }));

vi.mock('@stim-cli/core/state', async (original) => ({
  ...(await original<typeof import('@stim-cli/core/state')>()),
  followLogs: ({ onRecord }: { onRecord: () => void }) => {
    follower.changed = onRecord;
    if (follower.initialHint) onRecord();
    return follower.stop;
  },
}));

let home: string;
let root: string;
let abort: AbortController;

beforeEach(() => {
  vi.useFakeTimers();
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-web-verify-')));
  root = join(home, 'app');
  process.env.STIM_HOME = join(home, 'stim');
  mkdirSync(workspaceLogsDir(root), { recursive: true });
  abort = new AbortController();
  follower.changed = () => {};
  follower.initialHint = false;
  follower.stop.mockClear();
});

afterEach(() => {
  abort.abort();
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function record(event: string, fields = {}) {
  appendFileSync(webLogFile(root), `${JSON.stringify({ ts: Date.now(), src: 'web', event, ...fields })}\n`);
}

function verify(expectBundle = false, foreign: { reason: string; remedy: string } | null = null) {
  const runtime = browserWebProject(root).runtime({
    settings: {},
    headed: false,
    note: () => {},
    context: testContext({ signal: abort.signal }),
  });
  return runtime.verify(
    {
      url: 'http://localhost:3100/',
      config: { chrome: 'unused', headless: true, viewport: 'desktop', ignoreCertificateErrors: false },
      metroPort: null,
      verification: { template: null, expectBundle, serve: null, foreign },
    },
    { since: Date.now() },
  );
}

test('a hint with incomplete evidence cannot mark a page loaded', async () => {
  let settled = false;
  const pending = verify(true).then((value) => {
    settled = true;
    return value;
  });
  record('web_document_response', { status: 200 });
  follower.changed();
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(false);
  record('web_page_loaded');
  follower.changed();
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({ verdict: { launched: 'unverified', kind: 'no-bundle' } });
});

test('foreign Metro remains unverified even when the page has positive evidence', async () => {
  record('web_document_response', { status: 200 });
  record('web_page_loaded');
  expect(await verify(false, { reason: 'foreign Metro', remedy: 'restart' })).toMatchObject({
    verdict: { launched: 'unverified', reason: 'foreign Metro' },
    remedy: 'foreign Metro. restart',
  });
});

test('abort releases its observer and deadline without waiting for a repair tick', async () => {
  const pending = verify();
  const rejected = pending.catch((error: unknown) => error);
  abort.abort();
  expect(await rejected).toMatchObject({ code: 'STIM_CANCELLED' });
  expect(follower.stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
