const RUNG = {
  'idle-stop': 1,
  'derived-data-delete': 1,
  'parked-delete': 2,
  'cache-trim': 3,
  'device-delete': 4,
  'deps-delete': 5,
};

const CACHE_TRIM_RATIO = 0.9;

export function diffState(previous, next, at) {
  const events = [];
  for (const [label, now] of Object.entries(next.workspaces)) {
    const was = previous.workspaces[label];
    if (!was) continue;
    const add = (kind, detail) => events.push({ at, kind, rung: RUNG[kind], workspace: label, detail });
    if (was.metroUp && !now.metroUp) add('idle-stop', 'Metro stopped');
    if (was.devicesUp > 0 && now.devicesUp === 0) add('idle-stop', 'device shut down');
    if (was.derived && !now.derived) add('derived-data-delete', 'DerivedData deleted');
    if (was.deviceExists && !now.deviceExists) add('device-delete', 'owned device deleted');
    if ((was.nodeModules && !now.nodeModules) || (was.pods && !now.pods))
      add('deps-delete', 'node_modules or Pods deleted');
  }
  for (const [name, bytes] of Object.entries(next.caches)) {
    const was = previous.caches[name];
    if (typeof was === 'number' && bytes < was * CACHE_TRIM_RATIO) {
      events.push({
        at,
        kind: 'cache-trim',
        rung: RUNG['cache-trim'],
        workspace: null,
        detail: `${name} shrank from ${was} to ${bytes} bytes`,
      });
    }
  }
  return events;
}

export function checkRungOrder(events, toleranceMs) {
  const first = new Map();
  for (const event of events.toSorted((a, b) => a.at - b.at)) if (!first.has(event.rung)) first.set(event.rung, event);
  const rungs = [...first.keys()].toSorted((a, b) => a - b);
  const evidence = rungs.map(
    (rung) =>
      `rung ${rung} first freed at ${new Date(first.get(rung).at).toISOString().slice(11, 19)}: ${first.get(rung).kind} (${first.get(rung).workspace ?? 'shared'})`,
  );
  if (rungs.length < 2) return { verdict: 'unavailable', rungs, evidence };
  const violations = [];
  for (let i = 0; i < rungs.length; i++) {
    for (let j = i + 1; j < rungs.length; j++) {
      if (first.get(rungs[i]).at > first.get(rungs[j]).at + toleranceMs)
        violations.push(`rung ${rungs[j]} freed before rung ${rungs[i]}`);
    }
  }
  return { verdict: violations.length ? 'fail' : 'pass', rungs, evidence: [...evidence, ...violations] };
}
