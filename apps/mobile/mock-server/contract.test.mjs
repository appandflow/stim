import assert from 'node:assert/strict';
import { test } from 'node:test';

import { event, responses } from '../../../packages/core/receive-validators.mjs';
import { loadFixtures } from './fixtures.mjs';

for (const slotWaits of [false, true]) {
  const fixtures = loadFixtures({ slotWaits });

  test(`every status environment passes the phone validator (slot waits ${slotWaits})`, () => {
    const statusEvent = (environments) => ({
      event: 'status',
      subscription: 'mock',
      payload: { ...fixtures.status, environments },
    });
    const rejected = fixtures.status.environments
      .filter((environment) => !event(statusEvent([environment])))
      .map((environment) => environment.path);
    assert.deepEqual(rejected, []);
    assert.ok(event(statusEvent(fixtures.status.environments)));
  });
}

test('machine details, build plans and archive details pass the phone validator', () => {
  const fixtures = loadFixtures();
  assert.ok(responses['machine.details'](fixtures.machineDetails));
  for (const platform of ['ios', 'android']) assert.ok(responses['build.plan'](fixtures.plans[platform]), platform);
  const rejected = Object.entries(fixtures.archiveDetails)
    .filter(([, detail]) => !responses['archive.detail'](detail))
    .map(([id]) => id);
  assert.deepEqual(rejected, []);
});
