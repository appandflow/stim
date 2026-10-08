import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

const { platform, facts } = JSON.parse(readFileSync(process.env.STIM_CI_RUN_RESULT, 'utf8'));
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 15_000 }).trim();

function verify() {
  if (platform === 'ios') {
    assert.ok(facts.udid && facts.bundleId, 'iOS run must identify the simulator and app');
    run('xcrun', ['simctl', 'get_app_container', facts.udid, facts.bundleId, 'app']);
    const processes = run('xcrun', ['simctl', 'spawn', facts.udid, 'launchctl', 'list']);
    const app = processes
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find((fields) => /^\d+$/.test(fields[0]) && fields.slice(2).join(' ').includes(facts.bundleId));
    assert.ok(app, 'iOS app must have a running process');
    return app[0];
  } else if (platform === 'android') {
    assert.ok(facts.serial && facts.bundleId, 'Android run must identify the emulator and app');
    const pid = run('adb', ['-s', facts.serial, 'shell', 'pidof', facts.bundleId]);
    assert.match(pid, /^\d+(?:\s+\d+)*$/);
    return pid;
  } else if (platform === 'macos') {
    assert.ok(facts.pid && facts.executable, 'macOS run must identify its app process');
    assert.equal(run('/bin/ps', ['-p', String(facts.pid), '-o', 'comm=']), facts.executable);
    return String(facts.pid);
  } else {
    throw new Error(`No native app smoke probe for ${platform}.`);
  }
}

const pid = verify();
await setTimeout(5000);
assert.equal(verify(), pid, 'App process restarted during the smoke interval');
console.log(`${platform}: app installed and process remained alive through the smoke interval.`);
