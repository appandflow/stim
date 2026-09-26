import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCreatedDevices, recordCreatedDevice } from '../devices/created-devices.ts';
import { teardownOwnedBrowser } from '../devices/teardown.ts';
import { getNamedPort, clearNamedPorts, reserveBrowserPort } from '../named-ports.ts';
import { captureProcessToken, inspectProcessIdentity } from '../process-identity.ts';
import { environmentState, webFacts, withWebFacts } from '../status.ts';
import { resolveWebUrl } from '../commands/web.ts';
import { chromeArgs, findChrome } from '../web/chrome.ts';
import { consoleRecord, exceptionRecord, logEntryRecord, networkFailureRecord } from '../web/events.ts';
import { webLaunchVerdict } from '../web/launch.ts';
import { readWebRecord, webProfileDir, writeWebRecord, type WebRecord } from '../web/state.ts';
import { getProject, upsertProject } from '../workspace/config.ts';

let home: string;
let root: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-web-')));
  root = join(home, 'app');
  mkdirSync(root);
  process.env.STIM_HOME = join(home, 'stim');
});

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {}
  }
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

describe('Chrome launch', () => {
  test('uses the Stim profile and the reserved port, and adds certificate and window flags only when asked', () => {
    const args = chromeArgs({
      profile: '/stim/web/profile',
      port: 8901,
      headless: true,
      ignoreCertificateErrors: false,
      viewport: 'desktop',
    });
    expect(args).toEqual(expect.arrayContaining(['--user-data-dir=/stim/web/profile', '--remote-debugging-port=8901']));
    expect(args).toContain('--headless');
    expect(args).not.toContain('--ignore-certificate-errors');
    const headed = chromeArgs({
      profile: '/p',
      port: 1,
      headless: false,
      ignoreCertificateErrors: true,
      viewport: 'phone',
    });
    expect(headed).not.toContain('--headless');
    expect(headed).toContain('--ignore-certificate-errors');
    expect(headed).toContain('--window-size=390,844');
  });

  test('prefers an installed app bundle, then Chrome or Chromium on PATH, else none', () => {
    const onPath = (names: Record<string, string>) => (name: string) => names[name] ?? null;
    expect(
      findChrome({
        host: 'darwin',
        exists: (path) => path === '/Applications/Chromium.app/Contents/MacOS/Chromium',
        findExecutable: onPath({ 'google-chrome': '/usr/bin/google-chrome' }),
      }),
    ).toBe('/Applications/Chromium.app/Contents/MacOS/Chromium');
    expect(
      findChrome({ host: 'linux', exists: () => true, findExecutable: onPath({ chromium: '/usr/bin/chromium' }) }),
    ).toBe('/usr/bin/chromium');
    expect(findChrome({ host: 'linux', exists: () => false, findExecutable: () => null })).toBeNull();
  });
});

describe('web.url', () => {
  test('fills named ports and the Metro port, and refuses {port:metro} without a reservation', async () => {
    const namedPort = async (label: string) => ({ web: 8900, api: 8901 })[label as 'web' | 'api'];
    expect(
      await resolveWebUrl('https://localhost:{port:web}/apps/groups/?api={port:api}&m={port:metro}', {
        metroPort: 8081,
        namedPort,
      }),
    ).toBe('https://localhost:8900/apps/groups/?api=8901&m=8081');
    await expect(resolveWebUrl('http://localhost:{port:metro}/', { metroPort: null, namedPort })).rejects.toThrow(
      /Metro port/,
    );
  });
});

describe('browser port', () => {
  test('is a managed allocation users cannot take, stop or release', async () => {
    const free = { isFree: async () => true, log: () => {} };
    await expect(getNamedPort(root, 'web-cdp', free)).rejects.toThrow(/managed by stim web/);
    const cdp = await reserveBrowserPort(root, free);
    const web = await getNamedPort(root, 'web', free);
    expect(web).not.toBe(cdp);
    await clearNamedPorts(realpathSync(root), { log: () => {} });
    expect(getProject(realpathSync(root))?.ports).toEqual({ 'web-cdp': cdp });
  });
});

describe('page logs', () => {
  test('console calls keep their level and render object previews', () => {
    expect(
      consoleRecord({
        type: 'warning',
        args: [
          { type: 'string', value: 'count' },
          { type: 'number', value: 2 },
          { type: 'object', preview: { properties: [{ name: 'platform', type: 'string', value: 'web' }] } },
          { type: 'object', subtype: 'array', preview: { properties: [{ name: '0', type: 'number', value: '1' }] } },
        ],
      }),
    ).toEqual({ src: 'client', platform: 'web', level: 'warn', msg: 'count 2 {platform: "web"} [1]' });
  });

  test('an uncaught exception is a client error with 1-based frames', () => {
    const record = exceptionRecord({
      exceptionDetails: {
        text: 'Uncaught',
        exception: { type: 'object', subtype: 'error', description: 'Error: boom\n    at f (app.js:1:2)' },
        stackTrace: {
          callFrames: [{ functionName: 'f', url: 'http://localhost:8081/app.js', lineNumber: 0, columnNumber: 1 }],
        },
      },
    });
    expect(record).toMatchObject({ src: 'client', level: 'error', msg: 'Uncaught Error: boom' });
    expect(record.stack).toEqual([{ file: 'http://localhost:8081/app.js', line: 1, column: 2, fn: 'f' }]);
  });

  test('browser network log entries are dropped because the Network domain reports them', () => {
    expect(
      logEntryRecord({ entry: { source: 'network', level: 'error', text: 'Failed to load resource' } }),
    ).toBeNull();
    expect(logEntryRecord({ entry: { source: 'security', level: 'error', text: 'CSP' } })).toMatchObject({
      src: 'device',
      level: 'error',
    });
  });

  test('a failed document is an error, a 404 subresource a warning, a canceled request debug', () => {
    const base = { url: 'http://x/', method: 'GET' };
    expect(networkFailureRecord({ ...base, document: true, errorText: 'net::ERR_CONNECTION_REFUSED' })).toMatchObject({
      level: 'error',
      event: 'web_document_failed',
    });
    expect(networkFailureRecord({ ...base, document: false, status: 404 })).toMatchObject({ level: 'warn' });
    expect(networkFailureRecord({ ...base, document: true, errorText: 'x', canceled: true })).toMatchObject({
      level: 'debug',
      event: 'web_request_canceled',
    });
  });
});

describe('launched', () => {
  const at = (event: string, ts: number, extra = {}) => ({ src: 'device', platform: 'web', event, ts, ...extra });

  test('is true after a loaded document and, on Metro, a web bundle; evidence before the run is ignored', () => {
    const loaded = [at('web_document_response', 20, { status: 200 }), at('web_page_loaded', 30)];
    expect(webLaunchVerdict({ records: loaded, since: 10, expectBundle: false, final: false })?.launched).toBe(true);
    expect(webLaunchVerdict({ records: loaded, since: 25, expectBundle: false, final: true })?.launched).toBe(
      'unverified',
    );
    expect(webLaunchVerdict({ records: loaded, since: 10, expectBundle: true, final: false })?.launched).toBe(
      'unverified',
    );
    const bundled = [...loaded, at('web_bundle_response', 25, { status: 200 })];
    expect(webLaunchVerdict({ records: bundled, since: 10, expectBundle: true, final: false })?.launched).toBe(true);
  });

  test('a failed document decides unverified at once; otherwise it waits, then reports Metro bundling', () => {
    const refused = [at('web_document_failed', 20, { msg: 'GET http://localhost:8900/ failed' })];
    expect(webLaunchVerdict({ records: refused, since: 10, expectBundle: false, final: false })).toEqual({
      launched: 'unverified',
      reason: 'GET http://localhost:8900/ failed',
    });
    const started = [at('web_document_response', 20, { status: 200 })];
    expect(webLaunchVerdict({ records: started, since: 10, expectBundle: true, final: false })).toBeNull();
    const metroRecords = [{ src: 'metro', msg: 'Web Bundling index.ts 40%', ts: 15 }];
    expect(
      webLaunchVerdict({ records: started, metroRecords, since: 10, expectBundle: true, final: true })?.launched,
    ).toBe('bundling');
  });
});

function nodeProcess(script: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
  children.push(child);
  return child;
}

async function ownedBrowser(): Promise<WebRecord> {
  const supervisor = nodeProcess("process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);");
  const chrome = nodeProcess('setInterval(() => {}, 1000);');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const profile = webProfileDir(realpathSync(root));
  mkdirSync(profile, { recursive: true });
  symlinkSync(`${hostname()}-${chrome.pid}`, join(profile, 'SingletonLock'));
  writeFileSync(join(profile, 'SingletonCookie'), '');
  const record: WebRecord = {
    pid: supervisor.pid!,
    processToken: captureProcessToken(supervisor.pid!)!,
    chromeProcess: { pid: chrome.pid!, processToken: captureProcessToken(chrome.pid!)! },
    chrome: '/Applications/Chrome',
    headless: true,
    viewport: 'desktop',
    ignoreCertificateErrors: false,
    cdpPort: 8950,
    profile,
    url: 'http://localhost:8900/',
    startedAt: new Date().toISOString(),
  };
  upsertProject(realpathSync(root), { ports: { 'web-cdp': 8950 } });
  writeWebRecord(realpathSync(root), record);
  return record;
}

describe.skipIf(process.platform === 'win32')('browser teardown (POSIX process groups; skipped on win32)', () => {
  test('stop closes the verified supervisor and Chrome group, clears lock files and keeps the profile', async () => {
    const workspace = realpathSync(root);
    const record = await ownedBrowser();
    expect(webFacts(readWebRecord(workspace))?.status).toBe('running');
    const outcome = await teardownOwnedBrowser(workspace);
    expect(outcome.status).toBe('torn-down');
    expect(inspectProcessIdentity(record)).not.toBe('same');
    expect(inspectProcessIdentity(record.chromeProcess)).not.toBe('same');
    expect(() => lstatSync(join(record.profile, 'SingletonLock'))).toThrow(/ENOENT/);
    expect(existsSync(join(record.profile, 'SingletonCookie'))).toBe(false);
    expect(existsSync(record.profile)).toBe(true);
    expect(readWebRecord(workspace)).toBeNull();
    expect(getProject(workspace)?.ports).toEqual({});
  });

  test('never signals a recorded pid that another process now holds', async () => {
    const workspace = realpathSync(root);
    const record = await ownedBrowser();
    const stranger = nodeProcess('setInterval(() => {}, 1000);');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const identity = JSON.parse(Buffer.from(record.chromeProcess!.processToken.slice(6), 'base64url').toString());
    const reusedToken = `upid1.${Buffer.from(JSON.stringify({ ...identity, pid: stranger.pid })).toString('base64url')}`;
    const reused = { pid: stranger.pid!, processToken: reusedToken };
    writeWebRecord(workspace, { ...record, pid: reused.pid, processToken: reused.processToken, chromeProcess: reused });
    expect(inspectProcessIdentity(reused)).toBe('different');
    expect((await teardownOwnedBrowser(workspace)).status).toBe('skipped');
    expect(inspectProcessIdentity({ pid: stranger.pid, processToken: captureProcessToken(stranger.pid!) })).toBe(
      'same',
    );
  });

  test('deletes the profile only when the ledger lists it', async () => {
    const workspace = realpathSync(root);
    const record = await ownedBrowser();
    expect((await teardownOwnedBrowser(workspace, { deleteProfile: true })).status).toBe('skipped');
    expect(existsSync(record.profile)).toBe(true);
    recordCreatedDevice('web', record.profile);
    expect((await teardownOwnedBrowser(workspace, { deleteProfile: true })).status).toBe('missing');
    expect(existsSync(record.profile)).toBe(false);
    expect(readCreatedDevices().web.has(record.profile)).toBe(false);
  });

  test('leaves a Chrome that holds the profile without a supervisor record running', async () => {
    const workspace = realpathSync(root);
    const profile = webProfileDir(workspace);
    mkdirSync(profile, { recursive: true });
    symlinkSync(`${hostname()}-${process.pid}`, join(profile, 'SingletonLock'));
    expect(await teardownOwnedBrowser(workspace, { deleteProfile: true })).toMatchObject({ status: 'skipped' });
    expect(lstatSync(join(profile, 'SingletonLock')).isSymbolicLink()).toBe(true);
  });

  test('status reports a Chrome whose supervisor exited as orphaned, and stop still closes it', async () => {
    const workspace = realpathSync(root);
    const record = await ownedBrowser();
    process.kill(record.pid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const state = withWebFacts(
      environmentState({ ...getProject(workspace)!, __path: workspace }),
      webFacts(readWebRecord(workspace)),
    );
    expect(state.issues.map((issue) => issue.code)).toEqual(['browser-orphaned']);
    expect(state.live).toBe(true);
    expect((await teardownOwnedBrowser(workspace)).status).toBe('torn-down');
    expect(inspectProcessIdentity(record.chromeProcess)).not.toBe('same');
  });

  test('keeps the record when a Chrome the record does not name holds the profile', async () => {
    const workspace = realpathSync(root);
    const record = await ownedBrowser();
    const { chromeProcess, ...unrecorded } = record;
    writeWebRecord(workspace, unrecorded);
    expect(await teardownOwnedBrowser(workspace)).toMatchObject({ status: 'skipped', kind: 'not-verified' });
    expect(inspectProcessIdentity(chromeProcess)).toBe('same');
    expect(readWebRecord(workspace)).not.toBeNull();
  });

  test('status reports the running browser with its DevTools endpoint and counts the workspace live', async () => {
    const workspace = realpathSync(root);
    await ownedBrowser();
    const state = withWebFacts(
      environmentState({ ...getProject(workspace)!, __path: workspace }),
      webFacts(readWebRecord(workspace)),
    );
    expect(state.live).toBe(true);
    expect(state.web).toMatchObject({
      running: true,
      cdpEndpoint: 'http://127.0.0.1:8950',
      url: 'http://localhost:8900/',
    });
  });
});
