export class UsageError extends Error {}

const SCENARIOS = ['normal', 'disk', 'stress', 'check'];
const DEFAULT_WORKSPACES = { normal: 3, disk: 5, stress: 16, check: 2 };
const MIN_WORKSPACES = { normal: 1, disk: 4, stress: 1, check: 1 };
const DEFAULT_IDLE_MINUTES = 15;

const USAGE = `Usage: node run.mjs --scenario normal|disk|stress|check --project <path> --stim <path to dist/cli.mjs> [options]

  --target local|ssh:<user@host>   where to run (default local); with ssh, --project is a path on that host
  --workspaces <n>                 worktrees to create (default: normal 3, disk 5, stress 16, check 2)
  --out <dir>                      results directory (default ./rm-e2e-out/<timestamp>-<run id>); with ssh, a local directory
  --home-dir <dir>                 where the private STIM_HOME is created (default ~/rm-e2e on the target)
  --work-dir <dir>                 where the worktrees are created (default ~/rm-e2e on the target)
  --idle-minutes <n>               shorten the idle clock
  --dormant-minutes <n>            shorten the dormant clock and assert dormancy
  --max-load <n>                   start no build while the 1-minute load is at or over this (default 40)
  --env KEY=VALUE                  extra environment for every stim command (repeatable)`;

function number(name, raw, { integer = false, minimum = 0 } = {}) {
  const value = Number(raw);
  if (
    raw === undefined ||
    raw === '' ||
    !Number.isFinite(value) ||
    value < minimum ||
    (integer && !Number.isInteger(value))
  ) {
    throw new UsageError(
      `${name} takes ${integer ? 'an integer' : 'a number'} of at least ${minimum}, not ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

export function parseArgs(argv) {
  const raw = { env: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') throw new UsageError(USAGE);
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`);
    const eq = arg.indexOf('=');
    const name = (eq < 0 ? arg : arg.slice(0, eq)).slice(2);
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    if (name === 'env') raw.env.push(value);
    else raw[name] = value;
  }
  const known = [
    'scenario',
    'target',
    'project',
    'workspaces',
    'stim',
    'out',
    'home-dir',
    'work-dir',
    'idle-minutes',
    'dormant-minutes',
    'max-load',
    'env',
  ];
  const unknown = Object.keys(raw).find((key) => !known.includes(key));
  if (unknown) throw new UsageError(`unknown option --${unknown}`);

  if (!SCENARIOS.includes(raw.scenario))
    throw new UsageError(`--scenario takes ${SCENARIOS.join(', ')}, not ${JSON.stringify(raw.scenario)}`);
  if (!raw.project) throw new UsageError('--project is required');
  if (!raw.stim) throw new UsageError('--stim is required');
  const target = raw.target ?? 'local';
  if (target !== 'local' && !/^ssh:[^@\s]+@[^\s]+$/.test(target)) {
    throw new UsageError(`--target takes local or ssh:<user@host>, not ${JSON.stringify(target)}`);
  }
  const scenario = raw.scenario;
  const workspaces =
    raw.workspaces === undefined
      ? DEFAULT_WORKSPACES[scenario]
      : number('--workspaces', raw.workspaces, { integer: true, minimum: MIN_WORKSPACES[scenario] });
  const idleMinutes =
    raw['idle-minutes'] === undefined
      ? null
      : number('--idle-minutes', raw['idle-minutes'], { integer: true, minimum: 1 });
  const dormantMinutes =
    raw['dormant-minutes'] === undefined
      ? null
      : number('--dormant-minutes', raw['dormant-minutes'], { integer: true, minimum: 1 });
  if (dormantMinutes !== null && dormantMinutes <= (idleMinutes ?? DEFAULT_IDLE_MINUTES)) {
    throw new UsageError(`--dormant-minutes must exceed the idle clock (${idleMinutes ?? DEFAULT_IDLE_MINUTES} min)`);
  }
  const extraEnv = {};
  for (const pair of raw.env) {
    const at = pair.indexOf('=');
    if (at <= 0) throw new UsageError(`--env takes KEY=VALUE, not ${JSON.stringify(pair)}`);
    extraEnv[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return {
    scenario,
    target,
    project: raw.project,
    stim: raw.stim,
    out: raw.out ?? null,
    homeDir: raw['home-dir'] ?? null,
    workDir: raw['work-dir'] ?? null,
    workspaces,
    idleMinutes,
    dormantMinutes,
    maxLoad: raw['max-load'] === undefined ? 40 : number('--max-load', raw['max-load'], { minimum: 1 }),
    extraEnv,
  };
}
