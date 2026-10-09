import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

assert(
  process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'macOS' && process.platform === 'darwin',
  'This task-only harness runs exclusively on hosted macOS CI.',
);
const [mode, output] = process.argv.slice(2);
assert(['run', 'cleanup'].includes(mode) && output, 'Usage: node platform-convergence.mjs run|cleanup <output>');
const repo = realpathSync(process.env.GITHUB_WORKSPACE);
const out = resolve(output);
const runnerTemp = realpathSync(process.env.RUNNER_TEMP);
assert(out.startsWith(`${runnerTemp}${sep}`), 'Output must be inside this runner job temporary directory.');
const evidence = join(out, 'evidence');
const manifestPath = join(out, 'manifest.json');
mkdirSync(evidence, { recursive: true });
const { captureProcessToken, inspectProcessIdentity } = await import(
  pathToFileURL(join(repo, 'packages/core/dist/process-identity.mjs'))
);
let manifest;
let commandIndex = 0;
const summary = { checks: [], result: 'running' };
const jsonFile = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const saveManifest = () => jsonFile(manifestPath, manifest);
function checked(name) {
  summary.checks.push(name);
  console.log(`PASS ${name}`);
}
function insideHome(path) {
  const child = relative(manifest.home, realpathSync(path));
  assert(child && child !== '..' && !child.startsWith(`..${sep}`), `Artifact leaves test home: ${path}`);
}
function owned(pid) {
  assert(Number.isInteger(pid) && pid > 0, 'Expected an actual runtime PID.');
  const processToken = captureProcessToken(pid);
  assert(processToken, `Cannot establish process identity for ${pid}.`);
  const record = { pid, processToken };
  assert.equal(inspectProcessIdentity(record), 'same');
  manifest.identities.push(record);
  saveManifest();
  return record;
}
const alive = (record) => assert.equal(inspectProcessIdentity(record), 'same');
async function gone(record) {
  for (let n = 0; n < 50; n++) {
    const state = inspectProcessIdentity(record);
    if (state === 'gone' || state === 'different') return;
    await sleep(100);
  }
  assert.fail(`Recorded process ${record.pid} did not exit or could not be verified.`);
}
async function command(label, file, args, { allowFailure = false, timeout = 120_000 } = {}) {
  const prefix = join(evidence, `${mode}-${String(++commandIndex).padStart(3, '0')}-${label}`);
  const result = await new Promise((done) => {
    execFile(
      file,
      args,
      {
        cwd: manifest.root,
        env: { ...process.env, STIM_HOME: manifest.home, STIM_BIN: join(repo, 'packages/stim-cli/dist/cli.mjs') },
        encoding: 'utf8',
        timeout,
        killSignal: 'SIGINT',
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        done({ code: error ? (error.code ?? null) : 0, signal: error?.signal ?? null, stdout, stderr }),
    );
  });
  writeFileSync(`${prefix}.stdout`, result.stdout);
  writeFileSync(`${prefix}.stderr`, result.stderr);
  jsonFile(`${prefix}.json`, { file, args, code: result.code, signal: result.signal });
  if (!allowFailure) assert.equal(result.code, 0, `${label}: ${result.stderr}`);
  return result;
}
const cli = (label, args, options) =>
  command(label, process.execPath, [join(repo, 'packages/stim-cli/dist/cli.mjs'), ...args], options);
async function cliJson(label, args, options) {
  return JSON.parse((await cli(label, [...args, '--json'], options)).stdout);
}
async function logRecords(label, args = []) {
  return (await cli(label, ['logs', ...args, '--json'])).stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
async function waitForLog(marker) {
  for (let n = 0; n < 20; n++) {
    const records = await logRecords(`log-${marker}`, ['--source', 'client', '--grep', marker]);
    if (records.some((record) => record.msg?.includes(marker))) return records;
    await sleep(250);
  }
  assert.fail(`Runtime did not emit ${marker} through stim logs.`);
}
async function cleanup() {
  if (manifest.cleaned) return;
  const result = await cli('cleanup-stop', ['stop', '--json'], { allowFailure: true });
  const states = manifest.identities.map((record) => ({ ...record, state: inspectProcessIdentity(record) }));
  const ok =
    result.code === 0 &&
    JSON.parse(result.stdout).ok === true &&
    states.every(({ state }) => state === 'gone' || state === 'different');
  const workspaces = join(manifest.home, 'workspaces');
  if (existsSync(workspaces)) {
    for (const entry of readdirSync(workspaces, { withFileTypes: true })) {
      const logs = join(workspaces, entry.name, 'logs');
      if (entry.isDirectory() && existsSync(logs))
        cpSync(logs, join(evidence, 'workspace-logs', entry.name), { recursive: true });
    }
  }
  jsonFile(join(evidence, 'cleanup.json'), { ok, code: result.code, states });
  assert(ok, 'Scoped cleanup did not confirm every recorded runtime stopped; retaining its fixture and home.');
  rmSync(manifest.home, { recursive: true });
  rmSync(manifest.root, { recursive: true });
  manifest.cleaned = true;
  saveManifest();
}

if (mode === 'cleanup') {
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.root, join(out, 'fixture'));
    assert.equal(manifest.home, join(out, 'stim-home'));
    await cleanup();
  }
} else {
  assert(!existsSync(manifestPath), 'Refusing to overwrite an earlier run; inspect its evidence first.');
  manifest = { root: join(out, 'fixture'), home: join(out, 'stim-home'), identities: [], cleaned: false };
  mkdirSync(join(manifest.root, 'Sources', 'QaSwift'), { recursive: true });
  mkdirSync(manifest.home);
  saveManifest();
  const packageSource = `// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "QaSwift", platforms: [.macOS(.v13)], products: [.executable(name: "QaSwift", targets: ["QaSwift"])], targets: [.executableTarget(name: "QaSwift")])
`;
  writeFileSync(join(manifest.root, 'Package.swift'), packageSource);
  writeFileSync(join(manifest.root, 'package.json'), '{"name":"stim-qa-tooling-only","private":true}\n');
  writeFileSync(
    join(manifest.root, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.stim.qa.swiftpm</string>
<key>CFBundleExecutable</key><string>QaSwift</string>
<key>CFBundleName</key><string>QaSwift</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>\n`,
  );
  writeFileSync(join(manifest.root, 'resource.txt'), 'real staged resource\n');
  const writeSwift = (version) =>
    writeFileSync(
      join(manifest.root, 'Sources', 'QaSwift', 'main.swift'),
      `import Foundation\nFileHandle.standardOutput.write(Data(("QA_MACOS_${version} " + CommandLine.arguments.dropFirst().joined(separator: "|") + "\\n").utf8))\nwhile true { Thread.sleep(forTimeInterval: 1) }\n`,
    );
  writeSwift('V1');
  const server = createServer((request, response) => {
    if (request.url === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === '/bad') {
      response.writeHead(503);
      response.end('Intentional unavailable page');
      return;
    }
    const marker = request.url === '/two' ? 'QA_WEB_TWO' : 'QA_WEB_ONE';
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    response.end(`<!doctype html><title>${marker}</title><body>${marker}<script>console.log('${marker}');</script>`);
  });
  let settings;
  const writeSettings = () => jsonFile(join(manifest.root, '.stim.json'), settings);
  try {
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', done);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    settings = {
      macos: {
        product: 'QaSwift',
        infoPlist: 'Info.plist',
        arguments: ['qa-argument'],
        resources: { 'proof.txt': 'resource.txt' },
      },
      web: { url: `${baseUrl}/one` },
    };
    writeSettings();
    await cli('ios-viewer-setting', ['settings', 'set', 'iosSimulatorApp', 'stim-desktop']);
    await cli('android-viewer-setting', ['settings', 'set', 'androidEmulatorApp', 'stim-desktop']);
    await cli('agent-guide', ['guide', 'agent']);

    const first = await cliJson('macos-first', ['macos', '--remote-build', 'local'], { timeout: 480_000 });
    assert.equal(first.platform, 'macos');
    assert.equal(first.build.state, 'ok');
    assert.equal(first.build.builtOn, 'here');
    assert.match(first.bundleId, /^dev\.stim\.qa\.swiftpm\.stim\.[a-f0-9]{12}$/);
    insideHome(first.bundle);
    alive(first.app);
    alive(first.supervisor);
    manifest.identities.push(first.app, first.supervisor);
    saveManifest();
    assert.equal(
      readFileSync(join(first.bundle, 'Contents', 'Resources', 'proof.txt'), 'utf8'),
      'real staged resource\n',
    );
    await command('verify-signature', 'codesign', ['--verify', '--strict', first.bundle]);
    assert((await waitForLog('QA_MACOS_V1')).some((record) => record.msg.includes('qa-argument')));
    checked('real SwiftPM compile, staged resource, ad-hoc signature, owned launch and arguments in logs');

    const firstWeb = await cliJson('web-first', ['web']);
    assert.equal(firstWeb.platform, 'web');
    assert.equal(firstWeb.launched, true);
    assert.equal(firstWeb.running, true);
    assert.equal(firstWeb.reused, false);
    assert.equal(firstWeb.headless, true);
    assert.equal(firstWeb.metroPort, null);
    assert.equal(firstWeb.url, settings.web.url);
    insideHome(firstWeb.profile);
    const chrome = owned(firstWeb.pid);
    const webSupervisor = owned(firstWeb.supervisorPid);
    await waitForLog('QA_WEB_ONE');
    const beforeErrors = await logRecords('healthy-errors', ['--errors']);
    assert.equal(beforeErrors.length, 0, 'Healthy native and browser fixture must have no captured errors.');
    checked('configured web URL at a non-RN SwiftPM/tooling root launches real owned Chrome without Metro');

    settings.web.url = `${baseUrl}/bad`;
    writeSettings();
    const badWeb = await cliJson('web-http-failure', ['web']);
    assert.equal(badWeb.launched, 'unverified');
    assert.equal(badWeb.reused, true);
    assert.equal(badWeb.pid, firstWeb.pid);
    assert.equal(badWeb.running, true);
    assert((await logRecords('http-error-records', ['--errors'])).some((record) => record.status === 503));
    settings.web.url = `${baseUrl}/two`;
    writeSettings();
    const secondWeb = await cliJson('web-reuse', ['web']);
    assert.equal(secondWeb.launched, true);
    assert.equal(secondWeb.reused, true);
    assert.equal(secondWeb.pid, firstWeb.pid);
    assert.equal(secondWeb.supervisorPid, firstWeb.supervisorPid);
    assert.equal(secondWeb.targetId, firstWeb.targetId);
    assert.equal(secondWeb.profile, firstWeb.profile);
    await waitForLog('QA_WEB_TWO');
    checked('real navigation failure and recovery use fresh verdicts while retaining the owned Chrome and page');

    writeSwift('V2');
    const second = await cliJson('macos-rerun', ['macos', '--remote-build', 'local'], { timeout: 480_000 });
    assert.equal(second.build.state, 'ok');
    assert.notEqual(second.launchId, first.launchId);
    assert.equal(second.bundleId, first.bundleId);
    assert.equal(second.bundle, first.bundle);
    alive(second.app);
    alive(second.supervisor);
    manifest.identities.push(second.app, second.supervisor);
    saveManifest();
    await gone(first.app);
    await gone(first.supervisor);
    alive(chrome);
    alive(webSupervisor);
    await waitForLog('QA_MACOS_V2');
    checked('source edit rebuilds and relaunches SwiftPM with stable bundle identity and preserves Chrome');

    settings.macos.resources['proof.txt'] = 'missing-resource.txt';
    writeSettings();
    const refused = await cli('macos-invalid-resource', ['macos', '--remote-build', 'local', '--json'], {
      allowFailure: true,
    });
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /source does not exist/);
    alive(second.app);
    alive(second.supervisor);
    alive(chrome);
    alive(webSupervisor);
    settings.macos.resources['proof.txt'] = 'resource.txt';
    writeSettings();
    checked('invalid macOS resource refuses before stopping either existing runtime');

    const webStop = await cliJson('web-scoped-stop', ['stop', '--slot', 'web']);
    assert.equal(webStop.ok, true);
    assert.equal(webStop.device.web.status, 'shut-down');
    await gone(chrome);
    await gone(webSupervisor);
    alive(second.app);
    alive(second.supervisor);
    assert.equal((await fetch(`${baseUrl}/one`)).status, 200);
    const stop = await cliJson('workspace-stop', ['stop']);
    assert.equal(stop.ok, true);
    assert.equal(stop.macos.status, 'stopped');
    await gone(second.app);
    await gone(second.supervisor);
    assert.equal((await fetch(`${baseUrl}/one`)).status, 200);
    await logRecords('final-timeline');
    checked(
      'web-only stop preserves SwiftPM; workspace stop releases owned app and supervisor and leaves the external HTTP server',
    );
    summary.result = 'passed';
  } catch (error) {
    summary.result = 'failed';
    summary.error = error.stack ?? String(error);
    process.exitCode = 1;
    console.error(error);
  } finally {
    try {
      await cleanup();
    } catch (error) {
      summary.cleanupError = error.stack ?? String(error);
      summary.result = 'failed';
      process.exitCode = 1;
      console.error(error);
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
    jsonFile(join(evidence, 'summary.json'), summary);
  }
}
