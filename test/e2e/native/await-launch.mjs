import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildLog } from './harness.mjs';
import { readNdjsonGenerations } from '../../../packages/stim-cli/src/ndjson.ts';
import { verifyLaunch, readCollectorRecords } from '../../../packages/stim-cli/src/engine/launch-verify.ts';
import { isAppLaunchError } from '../../../packages/stim-cli/src/command-output.ts';
import { APP_READINESS_TIMEOUT_MS, appReadinessSignal } from '../../../packages/stim-cli/src/engine/app-readiness.ts';
import { iosAppProcess, androidAppProcess } from '../../../packages/stim-cli/src/engine/app-install.ts';
import { launchSlotScope, siblingPlatformSlots } from '../../../packages/stim-cli/src/engine/slot-launch.ts';
import { captureNativeCrashes } from '../../../packages/stim-cli/src/diagnostics/native-crash.ts';
import { deviceSlotKey } from '../../../packages/stim-cli/src/devices/device-slots.ts';
import { readWorkspaceLaunches } from '../../../packages/stim-cli/src/supervisor/state.ts';

assert(process.env.STIM_HOME, 'QA readiness observation requires an isolated STIM_HOME');
const [path, serializedFacts, policy] = process.argv.slice(2);
const expectUnattributed = policy === 'expect-unattributed-android-slot';
const root = realpathSync(path);
const facts = JSON.parse(serializedFacts);
const { platform, bundleId: appId, metroPort } = facts;
const slot = facts.slot ?? 'default';
assert(
  ['ios', 'android'].includes(platform) && [true, 'bundling', 'unverified'].includes(facts.launched),
  'expected a native launch to verify',
);
const deviceId = platform === 'ios' ? facts.udid : facts.serial;
const logsDir = typeof facts.logs === 'string' ? facts.logs : facts.logs?.dir;
const launch = readWorkspaceLaunches(root)[deviceSlotKey(platform, slot)];
assert(launch, 'the launch has no valid recorded attempt');
assert.equal(launch.appId, appId);
assert.equal(launch.deviceId, deviceId);
assert.equal(launch.metroPort, metroPort);
assert.equal(launch.release, false);
const since = Date.parse(launch.launchedAt);
assert(Number.isFinite(since), 'the launch has no valid launch time');
const logPath = buildLog(root);
assert(logPath, 'the launch has no build log');
const records = readNdjsonGenerations(logPath);
const attempt = records.findLast((record) => record.event === 'launch_attempt');
assert(attempt, 'the current build has no launch attempt');
assert.equal(attempt.platform, platform);
assert.equal(attempt.slot ?? 'default', slot);
assert.equal(attempt.appId, appId);
assert.equal(attempt.deviceId, deviceId);
assert.equal(Number(attempt.ts), since, 'the saved launch is not this build attempt');
assert(
  records.some(
    (record) =>
      record.event === `launch_${facts.launched === true ? 'verified' : facts.launched}` && Number(record.ts) >= since,
  ),
  'the build did not report this launch',
);
assert(typeof logsDir === 'string' && metroPort, 'the launch has no Metro evidence location');
const probe = () => (platform === 'ios' ? iosAppProcess(deviceId, appId) : androidAppProcess(deviceId, appId));
const pid = probe();
assert(Number.isInteger(pid) && pid > 0, 'the launch has no positively identified live app process');
const platformShared = siblingPlatformSlots(root, platform, slot).length > 0;
if (expectUnattributed) {
  assert(
    platform === 'android' && slot !== 'default' && platformShared,
    'the attribution exception requires an Android named slot with a live sibling',
  );
  assert.equal(facts.launched, 'unverified', 'shared Android slot must preserve its explicit unverified result');
}
const readCrashes = () =>
  captureNativeCrashes({ root, slot, platform, deviceId, appId, since, appPath: facts.appPath }, logsDir);
const result = await verifyLaunch({
  requireBundleResponse: true,
  slot: launchSlotScope(root, slot),
  appPid: platform === 'ios' ? pid : null,
  platformShared,
  logsDir,
  since,
  metroPort,
  platform,
  timeoutMs: expectUnattributed ? 3_000 : 120_000,
  processAlive: () => probe() === pid,
  readNativeCrashes: readCrashes,
});
let nonAppErrors = [];
if (expectUnattributed) {
  assert(
    !result.verified && result.unattributed && !result.fatal,
    'expected an explicit unattributed delivery refusal',
  );
  const deadline = Date.now() + APP_READINESS_TIMEOUT_MS;
  while (true) {
    assert.equal(probe(), pid, 'the named-slot app process changed or exited');
    const deviceRecords = readCollectorRecords(logsDir).filter(
      (record) => Number(record.ts) >= since && (record.slot ?? 'default') === slot && record.platform === platform,
    );
    const errors = deviceRecords.filter((record) => ['error', 'fatal'].includes(record.level));
    assert(!errors.some(isAppLaunchError), 'named-slot app reported errors');
    nonAppErrors = errors.filter((record) => !isAppLaunchError(record));
    const pending = deviceRecords.findLast((record) => appReadinessSignal(record, platform) === 'pending');
    if (
      !pending ||
      deviceRecords.some(
        (record) => Number(record.ts) >= Number(pending.ts) && appReadinessSignal(record, platform) === 'ready',
      )
    )
      break;
    assert(Date.now() < deadline, 'named-slot app readiness timed out');
    await sleep(500);
  }
  assert.equal(readCrashes().length, 0, 'named-slot app reported a native crash');
} else {
  assert(
    result.verified && result.processAlive === true && !result.fatal,
    'launch did not become verified with its live app process',
  );
  assert(!result.errors?.some(isAppLaunchError), 'launch reported app or bundle errors');
  nonAppErrors = (result.errors ?? []).filter((record) => !isAppLaunchError(record));
  assert(!['error', 'timed-out'].includes(result.readiness), 'app readiness failed or timed out');
}
process.stdout.write(
  `${JSON.stringify({ ...result, nonAppErrors, platform, slot, appId, deviceId, pid, since, delivery: expectUnattributed ? 'UNAVAILABLE: same-platform Android slot attribution' : 'verified' })}\n`,
);
assert.equal(probe(), pid, 'the verified app process changed or exited');
assert.deepEqual(
  readWorkspaceLaunches(root)[deviceSlotKey(platform, slot)],
  launch,
  'the launch attempt changed during observation',
);
