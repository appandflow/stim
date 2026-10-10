import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

const { platform, facts } = JSON.parse(readFileSync(process.env.STIM_CI_RUN_RESULT, 'utf8'));
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 15_000 }).trim();

const deadline = Date.now() + 60_000;
let lastUnavailable;

async function observeIos(args) {
  for (;;) {
    const started = Date.now();
    if (started + 15_000 > deadline) {
      throw new Error('iOS smoke observation deadline exceeded; simulator observations unavailable', {
        cause: lastUnavailable,
      });
    }
    try {
      const output = run('xcrun', args);
      assert.ok(Date.now() <= deadline, 'iOS smoke observation deadline exceeded');
      return output;
    } catch (error) {
      const unavailable = error.code === 'ETIMEDOUT';
      console.error(
        JSON.stringify({
          event: 'ios-smoke-observation',
          args,
          elapsedMs: Date.now() - started,
          outcome: unavailable ? 'unavailable' : 'failed',
          code: error.code,
          status: error.status,
          signal: error.signal,
          message: error.message,
          stdout: error.stdout,
          stderr: error.stderr,
        }),
      );
      if (!unavailable) throw error;
      lastUnavailable = error;
      await setTimeout(1000);
    }
  }
}

async function verify() {
  if (platform === 'ios') {
    assert.ok(facts.udid && facts.bundleId, 'iOS run must identify the simulator and app');
    await observeIos(['simctl', 'get_app_container', facts.udid, facts.bundleId, 'app']);
    const processes = await observeIos(['simctl', 'spawn', facts.udid, 'launchctl', 'list']);
    const app = processes
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find(
        (fields) =>
          /^\d+$/.test(fields[0]) &&
          Number(fields[0]) > 0 &&
          fields.slice(2).join(' ').startsWith(`UIKitApplication:${facts.bundleId}[`),
      );
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

const pid = await verify();
await setTimeout(5000);
assert.equal(await verify(), pid, 'App process restarted during the smoke interval');
console.log(`${platform}: app installed and process remained alive through the smoke interval.`);
