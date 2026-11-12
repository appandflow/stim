import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureProcessToken } from '../process-identity.ts';
import { writeWebRecord } from '../web/state.ts';

const observer = vi.hoisted((): { ends: (() => void)[]; failure: string | null } => ({ ends: [], failure: null }));
vi.mock('../stimd/logs/web.ts', () => ({
  observeBrowser: () => {
    let end!: () => void;
    const ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    observer.ends.push(end);
    return {
      attached: Promise.resolve(),
      ended,
      live: () => true,
      close: async () => {
        end();
        return observer.failure;
      },
      failure: () => observer.failure,
    };
  },
}));

test('a web observer whose writer failed is reported once and no longer blocks drains, launches or idle exit', async () => {
  const { createOwnedStreams } = await import('../stimd/logs/owned.ts');
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-owned-failure-home-')));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-owned-failure-app-')));
  vi.stubEnv('STIM_HOME', home);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  try {
    if (child.pid === undefined) throw new Error('the browser did not start');
    const chrome = { pid: child.pid, processToken: captureProcessToken(child.pid) ?? '' };
    writeWebRecord(root, {
      ...chrome,
      chromeProcess: chrome,
      chrome: process.execPath,
      headless: true,
      viewport: 'desktop',
      ignoreCertificateErrors: false,
      cdpPort: 1,
      profile: join(root, 'profile'),
      url: 'http://localhost:1/',
      startedAt: new Date().toISOString(),
    });
    const logged: string[] = [];
    const owned = createOwnedStreams((_level, event) => logged.push(event));
    expect(await owned.sync(root)).toBeNull();
    expect(owned.running()).toBe(true);

    observer.failure = 'the browser output could not be recorded: disk full';
    observer.ends[0]?.();
    await vi.waitFor(() => expect(owned.running()).toBe(false));
    expect(logged).toContain('web_observer_failed');

    expect(await owned.drain(root)).toBe(observer.failure);
    expect(await owned.drain(root)).toBeNull();

    observer.failure = null;
    expect(await owned.observeWeb(root, chrome.pid, chrome.processToken)).toBeNull();
    expect(owned.running()).toBe(true);
    await owned.close();
  } finally {
    child.kill('SIGKILL');
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
