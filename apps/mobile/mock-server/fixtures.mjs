import { existsSync, readFileSync } from 'node:fs';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);

export function loadFixtures({ slotWaits = false } = {}) {
  const status = JSON.parse(readFileSync(fixture('status.json'), 'utf8'));
  status.payload.environments.push(...JSON.parse(readFileSync(fixture('hosted-ios.json'), 'utf8')));
  if (slotWaits) {
    const changes = JSON.parse(readFileSync(fixture('slot-waits.json'), 'utf8')).environments;
    status.payload.environments = status.payload.environments.map((env) =>
      changes[env.path] ? { ...env, build: { ...env.build, ...changes[env.path] } } : env,
    );
  }
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
  };
}
