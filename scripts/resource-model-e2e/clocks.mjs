const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;

async function settingExists(stim, cwd, key) {
  const result = await stim.exec('settings-probe', cwd, ['settings', 'get', key, '--json']);
  return {
    exists: result.ok,
    value: result.ok ? (result.json?.value ?? null) : null,
    refusal: result.json?.message ?? result.stderr.trim(),
  };
}

async function writeSetting(stim, worktrees, key, value) {
  const first = worktrees[0].path;
  const machine = await stim.exec('settings-set', first, [
    'settings',
    'set',
    key,
    String(value),
    '--scope',
    'machine',
    '--json',
  ]);
  if (machine.ok) return { scope: 'machine', written: [first] };
  const written = [];
  for (const worktree of worktrees) {
    const result = await stim.exec('settings-set', worktree.path, [
      'settings',
      'set',
      key,
      String(value),
      '--scope',
      'workspace',
      '--json',
    ]);
    if (!result.ok) return { scope: null, refusal: result.json?.message ?? result.stderr.trim(), written };
    written.push(worktree.path);
  }
  return { scope: 'workspace', written };
}

async function effective(stim, worktrees, key) {
  const values = [];
  for (const worktree of worktrees) {
    const read = await settingExists(stim, worktree.path, key);
    values.push(read.value);
  }
  return values;
}

export async function configureClocks(stim, worktrees, { idleMinutes, dormantMinutes }) {
  const notes = [];
  const first = worktrees[0].path;
  const unified = await settingExists(stim, first, 'idle.minutes');
  const idleKeys = unified.exists ? ['idle.minutes'] : ['metro.idleStopMinutes', 'devices.idleShutdownMinutes'];
  if (idleMinutes !== null) {
    for (const key of idleKeys) {
      const wrote = await writeSetting(stim, worktrees, key, idleMinutes);
      notes.push(
        wrote.scope ? `${key} set to ${idleMinutes} in the ${wrote.scope} layer` : `${key} not set: ${wrote.refusal}`,
      );
    }
  }
  const values = (await Promise.all(idleKeys.map((key) => effective(stim, worktrees, key)))).flat();
  const numbers = values.filter((value) => typeof value === 'number' && value > 0);
  const idleWindowMinutes = numbers.length ? Math.max(...numbers) : null;
  notes.push(`effective idle clock: ${idleKeys.join(' and ')} = ${idleWindowMinutes ?? 'unreadable'} min`);

  const dormant = { available: false, reason: null, minutes: dormantMinutes };
  if (dormantMinutes !== null) {
    const probe = await settingExists(stim, first, 'idle.dormantDays');
    if (!probe.exists) {
      dormant.reason = `this build has no idle.dormantDays setting (${probe.refusal})`;
    } else {
      const days = dormantMinutes / DAY_MINUTES;
      const wrote = await writeSetting(stim, worktrees, 'idle.dormantDays', days);
      if (!wrote.scope) dormant.reason = `idle.dormantDays refused ${days}: ${wrote.refusal}`;
      else {
        const read = (await effective(stim, worktrees, 'idle.dormantDays'))[0];
        dormant.available = typeof read === 'number' && Math.abs(read * DAY_MINUTES - dormantMinutes) < 0.01;
        dormant.reason = dormant.available ? null : `idle.dormantDays read back as ${read}, not ${days}`;
        notes.push(`idle.dormantDays set to ${days} (${dormantMinutes} min) in the ${wrote.scope} layer`);
      }
    }
  }
  return { idleKeys, idleWindowMs: idleWindowMinutes === null ? null : idleWindowMinutes * MINUTE_MS, dormant, notes };
}
