import { existsSync, readFileSync } from 'node:fs';

import { shiftTimestamps } from './payloads.mjs';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);

export function loadFixtures({ slotWaits = false } = {}) {
  const status = JSON.parse(readFileSync(fixture('status.json'), 'utf8'));
  for (const platform of ['ios', 'android'])
    status.payload.environments.push(...JSON.parse(readFileSync(fixture(`hosted-${platform}.json`), 'utf8')));
  if (slotWaits) {
    const changes = JSON.parse(readFileSync(fixture('slot-waits.json'), 'utf8')).environments;
    status.payload.environments = status.payload.environments.map((env) =>
      changes[env.path] ? { ...env, build: { ...env.build, ...changes[env.path] } } : env,
    );
  }
  const realArchive = JSON.parse(readFileSync(fixture('real-archive/archive.json'), 'utf8'));
  const realShift = Date.parse(status.capturedAt) - 2 * 60 * 60 * 1000 - Date.parse(realArchive.removedAt);
  status.payload.archived.push(shiftTimestamps(realArchive, realShift));
  const archiveDetails = JSON.parse(readFileSync(fixture('archive-details.json'), 'utf8'));
  const realDetail = shiftTimestamps(JSON.parse(readFileSync(fixture('real-archive/detail.json'), 'utf8')), realShift);
  for (const recording of realDetail.recordings)
    recording.spans = recording.spans.map((span) => ({ start: span.start + realShift, end: span.end + realShift }));
  archiveDetails[realArchive.id] = realDetail;
  const logs = readFileSync(fixture('logs.ndjson'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const frames = {};
  for (const platform of ['ios', 'android', 'web']) {
    if (!existsSync(fixture(`frame-${platform}.json`))) continue;
    const frame = JSON.parse(readFileSync(fixture(`frame-${platform}.json`), 'utf8'));
    frames[platform] = { ...frame, data: readFileSync(fixture(`frame-${platform}.jpg`)).toString('base64') };
  }
  const plans = JSON.parse(readFileSync(fixture('plans.json'), 'utf8'));
  const machineDetails = JSON.parse(readFileSync(fixture('machine-details.json'), 'utf8'));
  return {
    capturedAt: status.capturedAt,
    stimVersion: status.stimVersion,
    home: status.home,
    status: status.payload,
    logs,
    plans,
    machineDetails,
    frames,
    archiveDetails,
  };
}
