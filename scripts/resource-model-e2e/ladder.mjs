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

const PRESSURE_IDLE_MESSAGE = /\(pressure level (high|critical|normal):/;

const parseLines = (text) =>
  text.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

const DUPLICATE_MS = 3000;

export function ladderActions({ daemonText = '', workspaceLogs = [] }) {
  const ticks = [];
  const found = [];
  const take = (record, source, hint) => {
    const workspace = record.workspace ?? hint ?? null;
    if (record.event === 'workspace_idle') {
      found.push({
        ts: record.ts,
        rung: 1,
        kind: 'idle-stage',
        workspace,
        target: workspace,
        bytes: record.freedBytes ?? 0,
        pressure: PRESSURE_IDLE_MESSAGE.exec(record.msg ?? '')?.[1] ?? null,
        source,
      });
    } else if (record.event === 'pressure_action' && record.outcome === 'done' && Number.isInteger(record.rung)) {
      found.push({
        ts: record.ts,
        rung: record.rung,
        kind: record.kind,
        workspace,
        target: record.target ?? workspace,
        bytes: record.bytes ?? 0,
        source,
      });
    }
  };
  for (const record of parseLines(daemonText)) {
    if (record.event === 'daemon_tick') ticks.push(record.ts);
    else take(record, 'daemon');
  }
  for (const { workspace, text } of workspaceLogs)
    for (const record of parseLines(text)) take(record, 'workspace log', workspace);
  const actions = [];
  for (const action of found.toSorted((a, b) => a.ts - b.ts)) {
    const twin = actions.find(
      (kept) =>
        kept.kind === action.kind && kept.target === action.target && Math.abs(kept.ts - action.ts) < DUPLICATE_MS,
    );
    if (!twin) actions.push(action);
  }
  return { actions, ticks: ticks.toSorted((a, b) => a - b) };
}

const hms = (ms) => new Date(ms).toISOString().slice(11, 19);
const nameOf = (path) => (path ? path.split('/').at(-1) : 'shared');

export function checkLadderOrder({ actions, ticks }, { skipWorkspaces = [] } = {}) {
  const evidence = actions.map(
    (a) => `${hms(a.ts)} rung ${a.rung} ${a.kind} ${nameOf(a.target)} (${a.bytes} bytes freed, ${a.source})`,
  );
  const rungs = [...new Set(actions.map((a) => a.rung))].toSorted((x, y) => x - y);
  if (rungs.length < 2) return { verdict: 'unavailable', rungs, evidence };
  const violations = [];
  const inOrder = (list, where) => {
    for (let i = 1; i < list.length; i++) {
      if (list[i].rung < list[i - 1].rung) {
        violations.push(
          `${where}: rung ${list[i].rung} (${nameOf(list[i].target)}) at ${hms(list[i].ts)} after rung ${list[i - 1].rung} (${nameOf(list[i - 1].target)}) at ${hms(list[i - 1].ts)}`,
        );
      }
    }
  };
  const notes = [];
  const byTick = new Map();
  if (!ticks.length) notes.push('the daemon log has no tick records, so the within-tick rule was not checked');
  for (const action of ticks.length ? actions : []) {
    const index = ticks.findIndex((tick) => tick >= action.ts);
    const key = index === -1 ? ticks.length : index;
    byTick.set(key, [...(byTick.get(key) ?? []), action]);
  }
  for (const [key, list] of byTick)
    inOrder(list, `within the tick ending ${key < ticks.length ? hms(ticks[key]) : 'after the last logged tick'}`);
  const byWorkspace = new Map();
  if (skipWorkspaces.length) {
    notes.push(
      `not checked per workspace, because the scenario starts and stops them: ${skipWorkspaces.map(nameOf).join(', ')}`,
    );
  }
  for (const action of actions.filter((a) => a.workspace && !skipWorkspaces.includes(a.workspace))) {
    byWorkspace.set(action.workspace, [...(byWorkspace.get(action.workspace) ?? []), action]);
  }
  for (const [workspace, list] of byWorkspace) inOrder(list, `for ${nameOf(workspace)}`);
  return { verdict: violations.length ? 'fail' : 'pass', rungs, evidence: [...evidence, ...notes, ...violations] };
}
