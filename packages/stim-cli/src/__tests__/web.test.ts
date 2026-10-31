import { writeWorkspaceState } from '../workspace/workspace-state.ts';
import { createStim } from '../api.ts';
import * as workspaceLocks from '../engine/workspace-process-lock.ts';
import assert from 'node:assert';
import * as chromeLookup from '../web/chrome.ts';
import * as browserCdp from '../web/cdp.ts';
import { resetExecutor, setExecutor, type Executor } from '../exec.ts';
import { makeExecutor } from './_factories.ts';
import { SETTING_SHAPE_REMEDY } from '../workspace/settings.ts';
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
import { BROWSER_LOCK, teardownOwnedBrowser } from '../devices/teardown.ts';
import { getNamedPort, clearNamedPorts, reserveBrowserPort } from '../named-ports.ts';
import { captureProcessToken, inspectProcessIdentity } from '../process-identity.ts';
import { environmentState, withWebFacts } from '../status.ts';
import { runWeb } from '../commands/web.ts';
import { launchOwnedBrowser } from '../web/runtime.ts';
import { chromeArgs, findChrome } from '../web/chrome.ts';
import { consoleRecord, exceptionRecord, logEntryRecord, networkFailureRecord } from '../web/events.ts';
import { parseInputBatch, webAgentRecords } from '../web/input.ts';
import { createNdjsonWriter, type NdjsonRecord } from '../ndjson.ts';
import { resolveWebUrl, webLaunchRemedy, webLaunchVerdict, webServePlan } from '../web/launch.ts';
import { NOT_OURS_FOREIGN_CWD } from '../metro.ts';
import {
  latestPageLoad,
  readWebPage,
  readWebRecord,
  webFacts,
  webFactsAsync,
  webProfileDir,
  webLogFile,
  writeWebRecord,
  type WebRecord,
} from '../web/state.ts';
import { getProject, upsertProject } from '../workspace/config.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { workspaceInUse } from '../workspace/in-use.ts';
import { staleBrowserProfiles } from '../commands/gc/ledger.ts';
import { testContext } from './_context.ts';

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

describe('web Metro pin', () => {
  beforeEach(() => {
    setExecutor(makeExecutor());
    upsertProject(root, { settings: { web: { url: 'http://localhost:{port:metro}/' } } });
  });

  afterEach(() => {
    resetExecutor();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test('an invalid pin returns a structured refusal before Chrome lookup or reservation', async () => {
    vi.stubEnv('STIM_METRO_PORT', '80');
    const chrome = vi.spyOn(chromeLookup, 'findChrome').mockReturnValue(null);

    const result = await runWeb({ root, headed: false, note: () => {} });

    expect(result).toMatchObject({ ok: false, error: { code: 'STIM_BAD_ARG', remedy: SETTING_SHAPE_REMEDY } });
    expect(chrome).not.toHaveBeenCalled();
    expect(getProject(root)?.metroPort).toBe(null);
  });

  test('a changed pin refuses with the old live supervisor reservation intact', async () => {
    vi.stubEnv('STIM_METRO_PORT', '25062');
    upsertProject(root, { metroPort: 8082 });
    writeWorkspaceState(root, {
      supervisor: {
        pid: process.pid,
        processToken: captureProcessToken(process.pid),
        port: 8082,
        mode: 'bare-inproc',
        startedAt: 'T',
      },
    });
    vi.spyOn(chromeLookup, 'findChrome').mockReturnValue('/chrome');
    const launch = vi.fn<Executor['spawn']>();
    setExecutor(makeExecutor({ spawn: launch }));

    const result = await runWeb({ root, headed: false, note: () => {} });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'STIM_BAD_ARG', remedy: expect.stringContaining('stim stop') },
    });
    expect(getProject(root)?.metroPort).toBe(8082);
    expect(launch).not.toHaveBeenCalled();
  });

  test('a page without Metro ignores an invalid pin', async () => {
    vi.stubEnv('STIM_METRO_PORT', '80');
    upsertProject(root, { settings: { web: { url: 'http://localhost:8901/' } } });
    vi.spyOn(chromeLookup, 'findChrome').mockReturnValue(null);

    const result = await runWeb({ root, headed: false, note: () => {} });

    expect(result).toMatchObject({ ok: false, error: { code: 'STIM_WEB_NO_CHROME' } });
    expect(getProject(root)?.metroPort).toBe(null);
  });

  test('a pin reserved by another workspace returns a structured refusal without launching', async () => {
    vi.stubEnv('STIM_METRO_PORT', '25062');
    upsertProject(join(home, 'other'), { metroPort: 25062 });
    vi.spyOn(chromeLookup, 'findChrome').mockReturnValue('/chrome');
    const launch = vi.fn<Executor['spawn']>();
    setExecutor(makeExecutor({ spawn: launch }));

    const result = await runWeb({ root, headed: false, note: () => {} });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'STIM_BAD_ARG',
        message: expect.stringContaining('already reserved'),
        remedy: 'Give each workspace its own metro.port, in the workspace layer or the environment.',
      },
    });
    expect(launch).not.toHaveBeenCalled();
    expect(getProject(root)?.metroPort).toBe(null);
    expect(getProject(join(home, 'other'))?.metroPort).toBe(25062);
  });
});

describe('selected web runtime preparation', () => {
  afterEach(() => {
    resetExecutor();
    vi.restoreAllMocks();
  });

  test.each([
    { manifest: { name: 'tools' }, expo: false, code: 'STIM_WEB_NO_URL' },
    { manifest: { dependencies: { expo: '*' } }, expo: true, code: 'STIM_WEB_DEPS_MISSING' },
  ])('keeps the $code refusal before browser launch', async ({ manifest, expo, code }) => {
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    if (expo) writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { name: 'fixture', slug: 'fixture' } }));
    vi.spyOn(chromeLookup, 'findChrome').mockReturnValue('/chrome');
    const launch = vi.fn<Executor['spawn']>();
    setExecutor(makeExecutor({ spawn: launch }));

    const result = await runWeb({ root, headed: false, note: () => {} });

    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(launch).not.toHaveBeenCalled();
    expect(getProject(root)?.metroPort).toBe(null);
    expect(readWebRecord(root)).toBeNull();
  });
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
    const chromium = join('/Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    expect(
      findChrome({
        host: 'darwin',
        exists: (path) => path === chromium,
        findExecutable: onPath({ 'google-chrome': '/usr/bin/google-chrome' }),
      }),
    ).toBe(chromium);
    expect(
      findChrome({ host: 'linux', exists: () => true, findExecutable: onPath({ chromium: '/usr/bin/chromium' }) }),
    ).toBe('/usr/bin/chromium');
    expect(findChrome({ host: 'linux', exists: () => false, findExecutable: () => null })).toBeNull();
  });
});

test('gc names a ledgered browser profile whose directory is gone, never one on a missing volume', () => {
  const gone = '/stim/workspaces/a/web/profile';
  const kept = '/stim/workspaces/b/web/profile';
  const unmounted = '/Volumes/Off/stim/workspaces/c/web/profile';
  const ledger = {
    ios: new Set<string>(),
    android: new Set<string>(),
    web: new Set([gone, kept, unmounted]),
    systemImages: new Set<string>(),
  };
  const present = new Set(['/stim/workspaces', kept]);
  expect(staleBrowserProfiles(ledger, (path) => present.has(path))).toEqual([{ kind: 'web', id: gone }]);
});

test.skipIf(process.platform === 'win32')(
  'gc keeps the ledger entry of a workspace linked to a missing volume (symlink creation needs privileges on win32)',
  () => {
    const workspaces = join(home, 'workspaces');
    mkdirSync(workspaces);
    symlinkSync(join(home, 'unmounted', 'ws'), join(workspaces, 'ws'));
    const profile = join(workspaces, 'ws', 'web', 'profile');
    const ledger = {
      ios: new Set<string>(),
      android: new Set<string>(),
      web: new Set([profile]),
      systemImages: new Set<string>(),
    };
    expect(staleBrowserProfiles(ledger)).toEqual([]);
  },
);

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
    const free = { isFree: async () => true };
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

describe('agent input', () => {
  test('becomes agent records for the page target, dropping malformed actions and counting lost ones', () => {
    const batch = parseInputBatch(
      JSON.stringify({
        actions: [
          { command: 'click', at: 1000, target: 'button "Save"', x: 10, y: 20 },
          { command: 'type', at: 2000, target: 'input#email[type=email]', characters: 12 },
          { command: 'press', at: 3000, target: null, key: 'Enter', count: 2 },
          { command: 'scroll', at: 4000, deltaX: 0, deltaY: -480, x: 5, y: 5 },
          { command: 'click', at: 'soon' },
          { command: 'hover', at: 5000 },
        ],
        dropped: 3,
      }),
    );
    const records = webAgentRecords(batch, 'TARGET', 'playwright', 9000);
    expect(records.map((record) => [record.ts, record.command, record.msg])).toEqual([
      [1000, 'click', 'Clicked button "Save"'],
      [2000, 'type', 'Typed 12 characters into input#email[type=email]'],
      [3000, 'press', 'Pressed Enter x2'],
      [4000, 'scroll', 'Scrolled up 480px'],
      [9000, 'input', '3 more input events were not recorded'],
    ]);
    for (const record of records) {
      expect(record).toMatchObject({
        src: 'agent',
        event: 'agent_action',
        platform: 'web',
        deviceId: 'TARGET',
        driver: 'playwright',
      });
    }
    expect(parseInputBatch('not json')).toEqual({ actions: [], dropped: 0 });
  });
});

describe('latest page load', () => {
  const line = (record: object) => JSON.stringify({ ts: 1, src: 'device', platform: 'web', ...record });
  const navigation = (url: string) => line({ event: 'web_navigation', url, marker: true, msg: `navigating to ${url}` });

  test('a failed document or a crash after the navigation fails the page with the log message', () => {
    const refused = networkFailureRecord({
      url: 'http://a/',
      method: 'GET',
      document: true,
      errorText: 'net::ERR_CONNECTION_REFUSED',
    });
    expect(latestPageLoad([navigation('http://a/'), line(refused)])).toEqual({
      url: 'http://a/',
      state: 'failed',
      error: 'GET http://a/ failed: net::ERR_CONNECTION_REFUSED',
    });
    expect(
      latestPageLoad([
        navigation('http://a/'),
        line({ event: 'web_page_loaded' }),
        line({ event: 'web_page_crashed', msg: 'the page renderer crashed (crashed)' }),
      ]),
    ).toMatchObject({ state: 'failed', error: 'the page renderer crashed (crashed)' });
    expect(latestPageLoad([navigation('http://a/'), line(refused), navigation('http://a/')])).toEqual({
      url: 'http://a/',
      state: 'loading',
    });
  });

  test('finds the navigation behind more console output than a log tail holds', () => {
    mkdirSync(workspaceLogsDir(root), { recursive: true });
    const chatter = Array.from({ length: 5000 }, (_, i) => line({ src: 'client', msg: `tick ${i} ${'x'.repeat(80)}` }));
    writeFileSync(
      join(workspaceLogsDir(root), 'web.ndjson'),
      [navigation('http://a/'), line({ event: 'web_page_loaded' }), ...chatter, ''].join('\n'),
    );
    expect(readWebPage(root)).toEqual({ url: 'http://a/', state: 'loaded' });
  });

  test('reports the newest in-app route since the navigation, and none from before it', () => {
    const route = (url: string) => line({ event: 'web_route', url, msg: `route changed to ${url}` });
    const lines = [
      navigation('http://a/'),
      line({ event: 'web_page_loaded' }),
      route('http://a/one'),
      route('http://a/two'),
    ];
    expect(latestPageLoad(lines)).toEqual({ url: 'http://a/', state: 'loaded', route: 'http://a/two' });
    expect(latestPageLoad([...lines, route('http://a/')])).toEqual({ url: 'http://a/', state: 'loaded' });
    expect(latestPageLoad([...lines, navigation('http://a/settings')])).toEqual({
      url: 'http://a/settings',
      state: 'loading',
    });
  });
});

describe('launched', () => {
  const at = (event: string, ts: number, extra = {}) => ({ src: 'device', platform: 'web', event, ts, ...extra });
  const verdict = (
    records: NdjsonRecord[],
    opts: { since?: number; expectBundle?: boolean; elapsedMs?: number } = {},
  ) => webLaunchVerdict({ records, since: 10, expectBundle: false, elapsedMs: 0, ...opts });

  test('a failed document decides unverified at once; otherwise it waits, then reports Metro bundling', () => {
    const refused = [at('web_document_failed', 20, { msg: 'GET http://localhost:8900/ failed' })];
    expect(verdict(refused)).toEqual({
      launched: 'unverified',
      kind: 'document-failed',
      reason: 'GET http://localhost:8900/ failed',
    });
    const started = [at('web_document_response', 20, { status: 200 })];
    expect(verdict(started, { expectBundle: true, elapsedMs: 19_999 })).toBeNull();
    const metroRecords = [{ src: 'metro', msg: 'Web Bundling index.ts 40%', ts: 15 }];
    expect(
      webLaunchVerdict({ records: started, metroRecords, since: 10, expectBundle: true, elapsedMs: 20_000 })?.launched,
    ).toBe('bundling');
  });

  test('the remedy follows what the page reported instead of assuming nothing listens', () => {
    const failed = (msg: string) => verdict([at('web_document_failed', 20, { msg })])!;
    const https = {
      url: 'https://localhost:8900/apps/groups/',
      template: 'https://localhost:{port:web}/apps/groups/',
      usesMetro: false,
      serve: 'Start the web dev server on that port',
    };
    const http = {
      ...https,
      url: 'http://localhost:8900/apps/groups/',
      template: 'http://localhost:{port:web}/apps/groups/',
    };
    expect(webLaunchRemedy(failed('GET x failed: net::ERR_CERT_AUTHORITY_INVALID'), https)).toContain(
      '`stim settings set web.ignoreCertificateErrors true --scope workspace`',
    );
    expect(webLaunchRemedy(failed('GET x failed: net::ERR_SSL_PROTOCOL_ERROR'), https)).toContain(
      "`stim settings set web.url 'http://localhost:{port:web}/apps/groups/' --scope workspace`",
    );
    expect(webLaunchRemedy(failed('GET x failed: net::ERR_EMPTY_RESPONSE'), http)).toContain(
      "`stim settings set web.url 'https://localhost:{port:web}/apps/groups/' --scope workspace`",
    );
    expect(webLaunchRemedy(failed('GET x failed: HTTP 404'), https)).toContain('base path');
    expect(webLaunchRemedy(failed('GET x failed: HTTP 500'), https)).toContain('failed to serve');
    expect(webLaunchRemedy(failed('GET x failed: net::ERR_CONNECTION_REFUSED'), https)).toMatch(/^Nothing served/);
    const loading = verdict([at('web_document_response', 20, { status: 200 })], { elapsedMs: 60_000 })!;
    expect(webLaunchRemedy(loading, https)).toContain('cold dev server');
  });

  test('on Metro, an unserved page points at stim start; an HTTP error or a missing bundle at the Metro build', () => {
    const metro = {
      url: 'http://localhost:8081/',
      template: null,
      usesMetro: true,
      serve: "Start this workspace's Metro with `stim start`",
    };
    const refused = verdict([at('web_document_failed', 20, { msg: 'GET x failed: net::ERR_CONNECTION_REFUSED' })])!;
    expect(webLaunchRemedy(refused, metro)).toContain('`stim start`, then run `stim web` again');
    const silent = verdict([], { elapsedMs: 20_000 })!;
    expect(webLaunchRemedy(silent, metro)).toContain('`stim start`');
    expect(webLaunchRemedy(silent, { ...metro, serve: null })).toContain('Metro may have failed');
    const failed = verdict([at('web_document_failed', 20, { msg: 'GET x failed: HTTP 500' })])!;
    expect(webLaunchRemedy(failed, metro)).toContain('Metro may have failed');
    const answered = verdict([at('web_document_response', 20, { status: 200 })], {
      expectBundle: true,
      elapsedMs: 20_000,
    })!;
    expect(webLaunchRemedy(answered, metro)).toContain('Metro may have failed');
  });
});

describe('what serves the page', () => {
  const plan = (opts: Partial<Parameters<typeof webServePlan>[0]>) =>
    webServePlan({ usesMetro: true, metro: { missing: true }, supervisorHeld: false, missingWebPackages: [], ...opts });

  test('an empty Metro port needs stim start, after the missing web packages', () => {
    expect(plan({})).toEqual({ serve: "Start this workspace's Metro with `stim start`", foreign: null });
    expect(plan({ missingWebPackages: ['react-dom'] }).serve).toMatch(/^Run `npx expo install .*` and `stim start`$/);
    expect(plan({ usesMetro: false }).serve).toContain('stim ports get web');
  });

  test('a running Metro or a starting supervisor serves the page', () => {
    const running = { metro: { pid: 7, leader: 7, cwd: '/app' } };
    expect(plan({ metro: running, missingWebPackages: ['react-dom'] })).toEqual({ serve: null, foreign: null });
    const unresponsive = { notOurs: "pid 7 on port 8084 does not answer Metro's /status", kind: 'unresponsive' };
    expect(plan({ metro: unresponsive, supervisorHeld: true })).toEqual({ serve: null, foreign: null });
  });

  test('another process on the port is foreign, and the remedy frees the port the way stim start will', () => {
    const unresponsive = { notOurs: "pid 7 on port 8084 does not answer Metro's /status", kind: 'unresponsive' };
    expect(plan({ metro: unresponsive }).foreign?.remedy).toMatch(/^Run `stim start`, which reserves a free/);
    const stranger = { notOurs: 'pid 7 on port 8084 runs from /other, outside /app', kind: NOT_OURS_FOREIGN_CWD };
    expect(plan({ metro: stranger, supervisorHeld: true }).foreign?.remedy).toMatch(
      /^Run `stim stop` and follow its output, then `stim start`/,
    );
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

describe.skipIf(process.platform === 'win32')('selected configured-URL runtime', () => {
  afterEach(() => {
    resetExecutor();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test.each(['message', 'disconnect', 'exit'])('browser registration settles from %s', async (ending) => {
    let registered = () => {};
    const publication = new Promise<void>((resolve) => {
      registered = resolve;
    });
    let supervisor: ChildProcess | undefined;
    setExecutor(
      makeExecutor({
        spawn: (_file, args = []) => {
          const child = spawn(
            process.execPath,
            [
              '-e',
              ending === 'exit'
                ? "process.on('message', () => process.exit(1)); setInterval(() => {}, 1000);"
                : "process.on('message', () => process.send?.('web-registered')); setInterval(() => {}, 1000);",
            ],
            { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
          );
          children.push(child);
          supervisor = child;
          assert(child.pid !== undefined);
          const processToken = captureProcessToken(child.pid);
          assert(processToken);
          const pid = child.pid;
          child.once(ending === 'exit' ? 'exit' : 'message', registered);
          if (ending === 'disconnect') child.disconnect();
          setImmediate(() => {
            if (ending === 'exit') {
              child.send('exit');
              return;
            }
            writeWebRecord(root, {
              pid,
              processToken,
              chromeProcess: { pid, processToken },
              chrome: '/fixture/chrome',
              headless: true,
              viewport: 'desktop',
              ignoreCertificateErrors: false,
              cdpPort: Number(args[args.indexOf('--port') + 1]),
              profile: webProfileDir(root),
              launchId: args[args.indexOf('--launch-id') + 1],
              targetId: 'ready-page',
              url: 'http://localhost:8901/ready',
              startedAt: new Date().toISOString(),
            });
            if (ending === 'disconnect') registered();
            else child.send('publish');
          });
          return child;
        },
      }),
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let finished = false;
    const launch = launchOwnedBrowser(
      {
        url: 'http://localhost:8901/ready',
        config: { chrome: '/fixture/chrome', headless: true, viewport: 'desktop', ignoreCertificateErrors: false },
      },
      { root, note: () => {} },
    ).then((result) => {
      finished = true;
      return result;
    });
    try {
      await publication;
      await vi.advanceTimersByTimeAsync(ending === 'disconnect' ? 1000 : 0);
      expect(finished).toBe(true);
      expect((await launch).ok).toBe(ending !== 'exit');
    } finally {
      await vi.advanceTimersByTimeAsync(1000);
      await launch;
      if (supervisor?.connected) supervisor.disconnect();
      vi.useRealTimers();
    }
  });

  test.each(['lock', 'connect', 'verify'])(
    'a web API cancellation during %s does not restart the browser',
    async (stage) => {
      const owned = { ...(await ownedBrowser()), targetId: 'owned-page' };
      writeWebRecord(root, owned);
      upsertProject(root, { settings: { web: { url: 'http://localhost:8901/cancelled' } } });
      vi.spyOn(chromeLookup, 'findChrome').mockReturnValue(owned.chrome);
      const spawnBrowser = vi.fn<Executor['spawn']>();
      setExecutor(makeExecutor({ spawn: spawnBrowser }));
      const controller = new AbortController();
      const navigations: string[] = [];
      vi.spyOn(browserCdp, 'connectOwnedBrowser').mockImplementation(async () => {
        if (stage === 'connect') controller.abort();
        return {
          async send(method) {
            if (method === 'Target.getTargetInfo') return { targetInfo: { url: owned.url } };
            if (method === 'Target.attachToTarget') return { sessionId: 'owned-session' };
            if (method === 'Page.navigate') {
              navigations.push(method);
              if (stage === 'verify') controller.abort();
              else {
                const writer = createNdjsonWriter(webLogFile(root));
                writer.write({ event: 'web_document_response', status: 200 });
                writer.write({ event: 'web_page_loaded' });
                writer.close();
              }
            }
            return {};
          },
          onEvent: () => {},
          onClose: () => {},
          close: () => {},
        };
      });
      let release = () => {};
      let entered = () => {};
      const held = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lock =
        stage === 'lock'
          ? workspaceLocks.withWorkspaceProcessLock(
              workspaceDir(root),
              BROWSER_LOCK,
              async () => {
                entered();
                await gate;
              },
              { external: true },
            )
          : Promise.resolve();
      if (stage === 'lock') await held;
      let waiting = () => {};
      const contended = new Promise<void>((resolve) => {
        waiting = resolve;
      });
      const originalLock = workspaceLocks.withWorkspaceProcessLock;
      if (stage === 'lock')
        vi.spyOn(workspaceLocks, 'withWorkspaceProcessLock').mockImplementation((directory, name, run, options) =>
          originalLock(directory, name, run, { ...options, onHeld: waiting }),
        );
      const result = createStim({ projectRoot: root })
        .run({ platform: 'web', signal: controller.signal })
        .then(
          (facts) => facts,
          (error: unknown) => error,
        );
      if (stage === 'lock') {
        await contended;
        controller.abort();
        release();
      }
      try {
        expect(await result).toMatchObject({ code: 'STIM_CANCELLED' });
        expect(navigations).toEqual(stage === 'verify' ? ['Page.navigate'] : []);
        expect(spawnBrowser).not.toHaveBeenCalled();
        expect(readWebRecord(root)).toMatchObject({
          pid: owned.pid,
          url: stage === 'verify' ? 'http://localhost:8901/cancelled' : owned.url,
        });
      } finally {
        release();
        await lock;
      }
    },
  );

  test('a cancelled new web launch drains its registered supervisor and browser', async () => {
    upsertProject(root, { settings: { web: { url: 'http://localhost:8901/cancelled' } } });
    vi.spyOn(chromeLookup, 'findChrome').mockReturnValue('/fixture/chrome');
    const controller = new AbortController();
    const launched: Array<Pick<WebRecord, 'pid' | 'processToken'>> = [];
    let registration: Promise<void> | undefined;
    setExecutor(
      makeExecutor({
        spawn: (_file, args = []) => {
          const supervisor = nodeProcess("process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);");
          const chrome = nodeProcess('setInterval(() => {}, 1000);');
          const supervisorPid = supervisor.pid;
          const chromePid = chrome.pid;
          assert(supervisorPid !== undefined && chromePid !== undefined);
          const supervisorToken = captureProcessToken(supervisorPid);
          const chromeToken = captureProcessToken(chromePid);
          assert(supervisorToken && chromeToken);
          launched.push(
            { pid: supervisorPid, processToken: supervisorToken },
            { pid: chromePid, processToken: chromeToken },
          );
          registration = new Promise<void>((resolve) =>
            setTimeout(() => {
              const profile = webProfileDir(root);
              mkdirSync(profile, { recursive: true });
              symlinkSync(`${hostname()}-${chromePid}`, join(profile, 'SingletonLock'));
              writeWebRecord(root, {
                pid: supervisorPid,
                processToken: supervisorToken,
                chromeProcess: { pid: chromePid, processToken: chromeToken },
                chrome: '/fixture/chrome',
                headless: true,
                viewport: 'desktop',
                ignoreCertificateErrors: false,
                cdpPort: Number(args[args.indexOf('--port') + 1]),
                profile,
                launchId: args[args.indexOf('--launch-id') + 1],
                url: 'http://localhost:8901/cancelled',
                startedAt: new Date().toISOString(),
              });
              controller.abort();
              resolve();
            }, 200),
          );
          return supervisor;
        },
      }),
    );
    try {
      await expect(
        createStim({ projectRoot: root }).run({ platform: 'web', signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
      expect(launched).toHaveLength(2);
      expect(launched.every((record) => ['gone', 'different'].includes(inspectProcessIdentity(record)))).toBe(true);
      expect(readWebRecord(root)).toBeNull();
    } finally {
      await registration;
    }
  });

  test.each([
    { kind: 'tooling', expo: false, manifest: JSON.stringify({ name: 'tools' }) },
    { kind: 'Expo without web dependencies', expo: true, manifest: JSON.stringify({ dependencies: { expo: '*' } }) },
    { kind: 'unreadable package manifest', expo: false, manifest: '{' },
  ])('uses the configured page at a $kind root and verifies each owned navigation', async ({ manifest, expo }) => {
    writeFileSync(join(root, 'package.json'), manifest);
    if (expo) writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { name: 'fixture', slug: 'fixture' } }));
    const owned = { ...(await ownedBrowser()), targetId: 'owned-page' };
    writeWebRecord(root, owned);
    const url = 'http://localhost:8901/selected-page/';
    upsertProject(root, { settings: { web: { url } } });
    vi.stubEnv('STIM_METRO_PORT', '80');
    vi.spyOn(chromeLookup, 'findChrome').mockReturnValue(owned.chrome);
    const spawnBrowser = vi.fn<Executor['spawn']>();
    setExecutor(makeExecutor({ spawn: spawnBrowser }));
    let status = 200;
    const navigations: unknown[] = [];
    vi.spyOn(browserCdp, 'connectOwnedBrowser').mockResolvedValue({
      async send(method, params) {
        if (method === 'Target.getTargetInfo') return { targetInfo: { url: owned.url } };
        if (method === 'Target.attachToTarget') return { sessionId: 'owned-session' };
        if (method === 'Page.navigate') {
          navigations.push(params?.url);
          const writer = createNdjsonWriter(webLogFile(root));
          if (status === 200) {
            writer.write({ event: 'web_document_response', status });
            writer.write({ event: 'web_page_loaded' });
          } else {
            writer.write({ event: 'web_document_failed', msg: `failed: HTTP ${status}` });
          }
          writer.close();
        }
        return {};
      },
      onEvent: () => {},
      onClose: () => {},
      close: () => {},
    });

    const loaded = await runWeb({ root, headed: false, note: () => {} });
    expect(loaded).toMatchObject({
      ok: true,
      remedy: null,
      facts: { url, launched: true, running: true, reused: true, metroPort: null, pid: owned.chromeProcess?.pid },
    });
    status = 503;
    const progress: string[] = [];
    const failed = await createStim({ projectRoot: root, onProgress: ({ message }) => progress.push(message) }).run({
      platform: 'web',
    });
    expect(failed).toMatchObject({
      platform: 'web',
      facts: { url, launched: 'unverified', running: true, reused: true, metroPort: null },
    });
    expect(progress.join('\n')).toContain('The dev server failed to serve');
    expect(navigations).toEqual([url, url]);
    expect(spawnBrowser).not.toHaveBeenCalled();
    expect(getProject(root)?.metroPort).toBe(null);
    expect(readWebRecord(root)).toMatchObject({ url, pid: owned.pid, chromeProcess: owned.chromeProcess });
  });
});

describe.skipIf(process.platform === 'win32')('browser teardown (POSIX process groups; skipped on win32)', () => {
  test.each(['supervisor', 'chrome'])(
    'cancelling after the %s signal preserves the profile and ownership records',
    async (target) => {
      const workspace = realpathSync(root);
      const record = await ownedBrowser();
      if (!record.chromeProcess) throw new Error('The fixture has no Chrome owner.');
      const chromePid = record.chromeProcess.pid;
      recordCreatedDevice('web', record.profile);
      const controller = new AbortController();
      const cancelled = new Error('cancel browser cleanup');
      const pid = target === 'supervisor' ? record.pid : record.chromeProcess.pid;
      const kill = process.kill.bind(process);
      const signals = vi.spyOn(process, 'kill').mockImplementation((signalled, name) => {
        const result = kill(signalled, name);
        if (Math.abs(signalled) === pid && name === 'SIGTERM') controller.abort(cancelled);
        return result;
      });
      try {
        await expect(
          teardownOwnedBrowser(workspace, {
            deleteProfile: true,
            operation: testContext({ signal: controller.signal }),
          }),
        ).rejects.toBe(cancelled);
        expect(readWebRecord(workspace)).toEqual(record);
        expect(readCreatedDevices().web.has(record.profile)).toBe(true);
        expect(existsSync(record.profile)).toBe(true);
        expect(getProject(workspace)?.ports?.['web-cdp']).toBe(record.cdpPort);
        expect(
          signals.mock.calls.some(([signalled, name]) => Math.abs(signalled) === chromePid && name === 'SIGTERM'),
        ).toBe(target === 'chrome');
        expect(signals.mock.calls.filter(([, name]) => name === 'SIGKILL')).toEqual([]);
      } finally {
        signals.mockRestore();
      }
    },
  );

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

  test('a running owned Chrome keeps gc from treating the workspace as idle', async () => {
    const workspace = realpathSync(root);
    const record = await ownedBrowser();
    expect(workspaceInUse(workspace)).toContain(`its owned Chrome (pid ${record.chromeProcess!.pid}) is running`);
    await teardownOwnedBrowser(workspace);
    expect(workspaceInUse(workspace)).toEqual([]);
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

  async function lingeringChrome(
    workspace: string,
    memberArgs: (profile: string) => string[],
  ): Promise<{ member: number }> {
    const record = await ownedBrowser();
    const script = `const m = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...JSON.parse(process.argv[1])], { stdio: 'ignore' }); console.log(m.pid); setTimeout(() => process.exit(0), 600);`;
    const leader = spawn(process.execPath, ['-e', script, JSON.stringify(memberArgs(record.profile))], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    children.push(leader);
    const member = await new Promise<number>((resolve) =>
      leader.stdout!.once('data', (chunk) => resolve(Number(String(chunk).trim()))),
    );
    const chromeProcess = { pid: leader.pid!, processToken: captureProcessToken(leader.pid!)! };
    await new Promise((resolve) => leader.once('exit', resolve));
    expect(inspectProcessIdentity(chromeProcess)).toBe('gone');
    rmSync(join(record.profile, 'SingletonLock'), { force: true });
    writeWebRecord(workspace, { ...record, chromeProcess });
    return { member };
  }

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test('stop signals a lingering Chrome group whose member still runs on the profile', async () => {
    const workspace = realpathSync(root);
    const { member } = await lingeringChrome(workspace, (profile) => [`--user-data-dir=${profile}`]);
    expect(alive(member)).toBe(true);
    expect(await webFactsAsync(readWebRecord(workspace))).toMatchObject({ status: 'orphaned' });
    expect((await teardownOwnedBrowser(workspace)).status).toBe('torn-down');
    expect(alive(member)).toBe(false);
    expect(readWebRecord(workspace)).toBeNull();
  });
});
