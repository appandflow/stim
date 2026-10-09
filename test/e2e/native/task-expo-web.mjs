import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

assert(
  process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Linux' && process.platform === 'linux',
  'This task-only driver runs on hosted Linux CI.',
);
const [mode, output] = process.argv.slice(2);
assert(['run', 'cleanup'].includes(mode) && output, 'Usage: node expo-web.mjs run|cleanup <output>');
const repo = realpathSync(process.env.GITHUB_WORKSPACE);
const out = resolve(output);
const runnerTemp = realpathSync(process.env.RUNNER_TEMP);
assert(out.startsWith(`${runnerTemp}${sep}`), 'Output must be inside this runner job temporary directory.');
const evidence = join(out, 'evidence');
const manifestPath = join(out, 'manifest.json');
mkdirSync(evidence, { recursive: true });
const { createStim } = await import(pathToFileURL(join(repo, 'packages/stim-cli/dist/api.mjs')));
const { captureProcessToken, inspectProcessIdentity } = await import(
  pathToFileURL(join(repo, 'packages/core/dist/process-identity.mjs'))
);
const { connectOwnedBrowser } = await import(pathToFileURL(join(repo, 'packages/stim-cli/src/web/cdp.ts')));
const jsonFile = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
let manifest;
let client;
let cdp;
let sessionId;
let sequence = 0;
const summary = {
  checks: [],
  result: 'running',
  uiCoverage:
    'Real headless Chrome DOM, clicks, errors, reload and screenshots; no human visual review, headed browser, accessibility audit, native platform or physical device coverage.',
};
const save = () => jsonFile(manifestPath, manifest);
const pass = (name) => {
  summary.checks.push(name);
  console.log(`PASS ${name}`);
};
function owned(pid) {
  assert(Number.isInteger(pid) && pid > 0);
  const processToken = captureProcessToken(pid);
  assert(processToken, `No process identity for ${pid}`);
  const record = { pid, processToken };
  assert.equal(inspectProcessIdentity(record), 'same');
  manifest.identities.push(record);
  save();
  return record;
}
async function waitFor(label, read, accepts, timeout = 30_000) {
  const end = Date.now() + timeout;
  do {
    const value = await read();
    if (accepts(value)) return value;
    await sleep(250);
  } while (Date.now() < end);
  assert.fail(`Timed out: ${label}`);
}
const gone = (record) =>
  waitFor(
    `process ${record.pid} exit`,
    () => inspectProcessIdentity(record),
    (state) => state === 'gone' || state === 'different',
  );
async function command(label, file, args, timeout = 120_000, env = {}) {
  const prefix = join(evidence, `${mode}-${String(++sequence).padStart(3, '0')}-${label}`);
  const result = await new Promise((done) =>
    execFile(
      file,
      args,
      {
        cwd: manifest.root,
        env: {
          ...process.env,
          STIM_HOME: manifest.home,
          STIM_BIN: join(repo, 'packages/stim-cli/dist/cli.mjs'),
          npm_config_cache: join(out, 'npm-cache'),
          EXPO_NO_TELEMETRY: '1',
          FORCE_COLOR: '0',
          ...env,
        },
        encoding: 'utf8',
        timeout,
        killSignal: 'SIGINT',
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        done({ code: error ? (error.code ?? null) : 0, signal: error?.signal ?? null, stdout, stderr }),
    ),
  );
  writeFileSync(`${prefix}.stdout`, result.stdout);
  writeFileSync(`${prefix}.stderr`, result.stderr);
  jsonFile(`${prefix}.json`, { file, args, env, code: result.code, signal: result.signal });
  assert.equal(result.code, 0, `${label}: ${result.stderr}`);
  return result.stdout;
}
const cli = (label, args, timeout) =>
  command(label, process.execPath, [join(repo, 'packages/stim-cli/dist/cli.mjs'), ...args], timeout);
async function api(label, operation) {
  try {
    const result = await operation();
    jsonFile(join(evidence, `${mode}-${++sequence}-${label}.json`), result);
    return result;
  } catch (error) {
    jsonFile(join(evidence, `${mode}-${++sequence}-${label}-error.json`), {
      code: error.code,
      message: error.message,
      details: error.details,
    });
    throw error;
  }
}
function openClient() {
  client = createStim({
    projectRoot: manifest.root,
    home: manifest.home,
    onProgress: ({ stream, message }) => appendFileSync(join(evidence, `api-${mode}-${stream}.log`), message),
  });
}
async function evaluate(expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
  assert(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
  return response.result.value;
}
const textOf = (id) =>
  evaluate(`document.querySelector('[data-testid="${id}"]')?.textContent ?? null`).catch((error) => {
    if (/Execution context was destroyed|Cannot find context/.test(error.message)) return null;
    throw error;
  });
const rendered = () =>
  waitFor(
    'Expo marker rendered',
    () => textOf('marker'),
    (text) => text === 'QA_EXPO_WEB_READY',
    120_000,
  );
async function click(id) {
  const point = await evaluate(
    `(() => { const r = document.querySelector('[data-testid="${id}"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 }, sessionId);
}
async function screenshot(label) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(join(evidence, `${label}.png`), Buffer.from(data, 'base64'));
}
async function cleanup() {
  if (manifest.cleaned) return;
  cdp?.close();
  cdp = undefined;
  const stopped = await api('cleanup-stop', () => client.stop({ signal: AbortSignal.timeout(60_000) }));
  assert.equal(stopped.ok, true);
  for (const process of manifest.identities) await gone(process);
  if (manifest.logs && existsSync(manifest.logs))
    cpSync(manifest.logs, join(evidence, 'workspace-logs'), { recursive: true });
  if (manifest.registered) await cli('scoped-environment-remove', ['worktree', 'remove', manifest.root]);
  if (manifest.profile) assert(!existsSync(manifest.profile), 'Scoped removal left the owned Chrome profile.');
  if (manifest.metroPort) {
    let stoppedServing = false;
    try {
      await fetch(`http://127.0.0.1:${manifest.metroPort}/status`, { signal: AbortSignal.timeout(2000) });
    } catch {
      stoppedServing = true;
    }
    assert(stoppedServing, 'Owned Metro still answers after stop.');
  }
  jsonFile(join(evidence, 'cleanup.json'), {
    ok: true,
    identities: manifest.identities.map((record) => ({ ...record, state: inspectProcessIdentity(record) })),
  });
  rmSync(manifest.home, { recursive: true, force: true });
  rmSync(manifest.root, { recursive: true, force: true });
  manifest.cleaned = true;
  save();
}
if (mode === 'cleanup') {
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.root, join(out, 'fixture'));
    assert.equal(manifest.home, join(out, 'stim-home'));
    if (!manifest.cleaned) {
      openClient();
      await cleanup();
    }
  }
} else {
  assert(!existsSync(manifestPath), 'Refusing to overwrite an earlier run.');
  manifest = {
    root: join(out, 'fixture'),
    home: join(out, 'stim-home'),
    identities: [],
    cleaned: false,
    registered: false,
  };
  mkdirSync(manifest.root);
  mkdirSync(manifest.home);
  save();
  openClient();
  jsonFile(join(evidence, 'run-environment.json'), {
    commit: process.env.GITHUB_SHA,
    runner: process.env.RUNNER_OS,
    node: process.version,
    mode: 'real headless Chrome with Expo Metro',
  });
  const dependencies = {
    expo: '58.0.0-preview.7',
    react: '19.3.0',
    'react-native': '0.88.0-rc.1',
    'react-dom': '19.3.0',
    'react-native-web': '0.21.0',
    '@expo/metro-runtime': '58.0.7',
  };
  jsonFile(join(manifest.root, 'package.json'), {
    name: 'stim-qa-expo-web',
    version: '1.0.0',
    private: true,
    main: 'index.js',
    dependencies,
  });
  jsonFile(join(manifest.root, 'app.json'), {
    expo: { name: 'Stim QA Expo Web', slug: 'stim-qa-expo-web', web: { bundler: 'metro' } },
  });
  writeFileSync(
    join(manifest.root, 'index.js'),
    "import '@expo/metro-runtime';\nimport { registerRootComponent } from 'expo';\nimport App from './App';\nregisterRootComponent(App);\n",
  );
  writeFileSync(
    join(manifest.root, 'App.js'),
    `import React, { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
export default function App() {
  const [count, setCount] = useState(0);
  const [mount] = useState(() => 'mount-' + Math.random().toString(36).slice(2));
  return <View style={{ padding: 40, gap: 20 }}>
    <Text testID="marker">QA_EXPO_WEB_READY</Text><Text testID="mount">{mount}</Text>
    <Text testID="count">{count}</Text>
    <Pressable testID="increment" accessibilityRole="button" onPress={() => setCount(value => value + 1)}><Text>Increment</Text></Pressable>
    <Pressable testID="fail" accessibilityRole="button" onPress={() => setTimeout(() => { throw new Error('QA_EXPO_WEB_FAILURE'); }, 0)}><Text>Trigger expected error</Text></Pressable>
  </View>;
}
`,
  );
  try {
    await cli('ios-viewer-setting', ['settings', 'set', 'iosSimulatorApp', 'stim-desktop']);
    await cli('android-viewer-setting', ['settings', 'set', 'androidEmulatorApp', 'stim-desktop']);
    await cli('agent-guide', ['guide', 'agent']);
    await command('fixture-install', 'npm', ['install', '--no-audit', '--no-fund'], 600_000);
    cpSync(join(manifest.root, 'package-lock.json'), join(evidence, 'fixture-package-lock.json'));
    cpSync(join(manifest.root, 'package.json'), join(evidence, 'fixture-package.json'));
    cpSync(
      join(manifest.root, 'node_modules/expo/bundledNativeModules.json'),
      join(evidence, 'expo-bundledNativeModules.json'),
    );
    await command(
      'expo-pinned-sdk-version-check',
      process.execPath,
      [join(manifest.root, 'node_modules/expo/bin/cli'), 'install', '--check'],
      120_000,
      { EXPO_OFFLINE: '1' },
    );
    manifest.registered = true;
    save();
    const start = JSON.parse(await cli('start', ['start', '--json', '--wait', '120'], 180_000));
    manifest.metroPort = start.port;
    manifest.logs = start.logsDir;
    save();
    const metroSupervisor = owned(start.supervisorPid);
    const first = (await api('web-first', () => client.run({ platform: 'web', signal: AbortSignal.timeout(180_000) })))
      .facts;
    assert.equal(first.running, true);
    assert.equal(first.reused, false);
    assert.equal(first.headless, true);
    assert([true, 'bundling', 'unverified'].includes(first.launched), `Unexpected cold verdict: ${first.launched}`);
    assert.equal(first.metroPort, start.port);
    assert.equal(first.url, `http://localhost:${start.port}/`);
    assert(first.profile.startsWith(`${realpathSync(manifest.home)}${sep}`));
    manifest.profile = first.profile;
    save();
    const chrome = owned(first.pid);
    const supervisor = owned(first.supervisorPid);
    cdp = await connectOwnedBrowser(Number(new URL(first.cdpEndpoint).port), first.pid);
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: first.targetId, flatten: true }));
    await rendered();
    await click('increment');
    await waitFor(
      'increment updates DOM',
      () => textOf('count'),
      (text) => text === '1',
    );
    const coldProof = await api('cold-browser-proof', () =>
      client.diagnostics({ tail: 2000, signal: AbortSignal.timeout(20_000) }),
    );
    const bundle = coldProof.records.find(
      (record) => record.event === 'web_bundle_response' && Number(record.status) < 400,
    );
    assert(bundle, 'Rendered Expo page lacks captured successful web bundle evidence.');
    summary.coldLaunch = {
      initialVerdict: first.launched,
      observed: 'rendered-and-interactive',
      bundleStatus: bundle.status,
    };
    await screenshot('cold-click');
    pass('Expo default Metro URL renders real DOM and handles a browser click');

    const warm = (await api('web-warm', () => client.run({ platform: 'web', signal: AbortSignal.timeout(120_000) })))
      .facts;
    assert.equal(warm.launched, true);
    assert.equal(warm.reused, true);
    for (const key of ['pid', 'supervisorPid', 'profile', 'targetId', 'cdpEndpoint', 'metroPort'])
      assert.equal(warm[key], first[key], key);
    assert.equal(inspectProcessIdentity(chrome), 'same');
    await rendered();
    await screenshot('warm');
    pass('warm public API run reuses the owned Chrome, supervisor, profile and page');
    const oldMount = await textOf('mount');
    await click('fail');
    const errorLogs = await waitFor(
      'runtime error captured',
      () => client.diagnostics({ errors: true, tail: 500, signal: AbortSignal.timeout(20_000) }),
      (logs) => logs.records.some((record) => record.level === 'error' && record.msg?.includes('QA_EXPO_WEB_FAILURE')),
    );
    jsonFile(join(evidence, 'expected-error.json'), errorLogs);
    await screenshot('expected-error');
    const reload = JSON.parse(await cli('reload', ['reload', 'web', '--json']));
    assert.equal(reload.strategy, 'cdp');
    await waitFor(
      'reload remounts Expo',
      () => textOf('mount'),
      (text) => typeof text === 'string' && text !== oldMount,
      120_000,
    );
    await rendered();
    await click('increment');
    await waitFor(
      'recovered click',
      () => textOf('count'),
      (text) => text === '1',
    );
    await screenshot('recovered');
    pass('runtime error reaches diagnostics and observed reload restores a working app');
    const diagnostics = await api('timeline', () =>
      client.diagnostics({ tail: 2000, signal: AbortSignal.timeout(20_000) }),
    );
    assert(diagnostics.records.some((record) => record.event === 'web_navigation' && record.reload === true));
    cdp.close();
    cdp = undefined;
    const stopped = await api('web-scoped-stop', () =>
      client.stop({ slot: 'web', signal: AbortSignal.timeout(60_000) }),
    );
    assert.equal(stopped.ok, true);
    assert.equal(stopped.outcomes.device.web.status, 'shut-down');
    await gone(chrome);
    await gone(supervisor);
    assert.equal(inspectProcessIdentity(metroSupervisor), 'same');
    assert.match(
      await (await fetch(`http://127.0.0.1:${start.port}/status`, { signal: AbortSignal.timeout(5000) })).text(),
      /packager-status:running/,
    );
    pass('web-only API stop closes Chrome while the owned Expo Metro remains live');
    summary.result = 'passed';
  } catch (error) {
    summary.result = 'failed';
    summary.error = error.stack ?? String(error);
    process.exitCode = 1;
    if (cdp) {
      try {
        await screenshot('failure');
      } catch {}
    }
    console.error(error);
  } finally {
    try {
      await cleanup();
      pass('workspace stop and scoped removal release recorded processes and Chrome profile');
    } catch (error) {
      summary.result = 'failed';
      summary.cleanupError = error.stack ?? String(error);
      process.exitCode = 1;
      console.error(error);
    }
    jsonFile(join(evidence, 'summary.json'), summary);
  }
}
