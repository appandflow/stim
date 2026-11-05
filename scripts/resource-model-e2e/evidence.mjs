export function findEnvironment(payload, path) {
  return payload?.environments?.find((env) => env.path === path) ?? null;
}

function* walk(value) {
  if (Array.isArray(value)) for (const item of value) yield* walk(item);
  else if (value && typeof value === 'object') {
    yield value;
    for (const item of Object.values(value)) yield* walk(item);
  }
}

function lastActivityMs(env) {
  let best = null;
  for (const node of walk(env)) {
    const at = typeof node.lastActivityAt === 'string' ? Date.parse(node.lastActivityAt) : NaN;
    if (Number.isFinite(at) && (best === null || at > best)) best = at;
  }
  return best;
}

function iosDevices(env) {
  const seen = new Map();
  for (const device of [env?.ios, ...(env?.slots ?? []).map((slot) => slot.ios)]) {
    if (device?.udid) seen.set(device.udid, device);
  }
  return [...seen.values()];
}

export function idleFacts(env) {
  if (!env) return { present: false };
  const devices = iosDevices(env);
  const stageKind = env.stage?.kind ?? null;
  const metroRunning = env.metro ? Boolean(env.metro.running) : false;
  const metroIdleStop = Boolean(env.metro?.idleStop) || env.metro?.lastStop?.reason === 'idle';
  const devicesUp = devices.filter((device) => device.state === 'Booted' || device.state === 'Booting');
  const idleShutdowns = devices.filter((device) => device.idleShutdown).length;
  const idleStage = env.idleStage ?? null;
  const dormantStage = env.dormantStage ?? null;
  const stageIdle = idleStage !== null || dormantStage !== null;
  return {
    present: true,
    stageKind,
    stageIdle,
    idleStage,
    dormantStage,
    metroRunning,
    metroIdleStop,
    deviceCount: devices.length,
    devicesUp: devicesUp.length,
    idleShutdowns,
    idle: stageIdle || (metroIdleStop && !metroRunning && devicesUp.length === 0),
    lastActivityMs: lastActivityMs(env),
    appRunning: devices.some((device) => device.app?.state === 'running'),
    udids: devices.map((device) => device.udid),
  };
}

export function bootsInFlight(payload) {
  const holders = payload?.capacity?.devices?.holders;
  return Array.isArray(holders) ? holders.filter((holder) => holder.booting).length : null;
}

export function waitingRuns(payload) {
  return (payload?.environments ?? []).filter((env) => env.build?.waitingFor).length;
}

export function daemonLine(payload) {
  const daemon = payload?.daemon;
  return daemon === undefined ? null : daemon;
}
