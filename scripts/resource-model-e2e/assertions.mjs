export const STATUS = { pass: 'pass', fail: 'fail', unavailable: 'unavailable' };

export const clock = (ms) => new Date(ms).toISOString().slice(11, 19);

export function createAssertions() {
  const list = [];
  const add = (status, scenario, id, title, evidence = []) => {
    list.push({ scenario, id, title, status, evidence });
  };
  return {
    list,
    pass: (scenario, id, title, evidence) => add(STATUS.pass, scenario, id, title, evidence),
    fail: (scenario, id, title, evidence) => add(STATUS.fail, scenario, id, title, evidence),
    unavailable: (scenario, id, title, evidence) => add(STATUS.unavailable, scenario, id, title, evidence),
    fromItems(scenario, id, title, items) {
      const checked = items.filter((item) => item.status !== STATUS.unavailable);
      const failed = items.some((item) => item.status === STATUS.fail);
      const status = failed ? STATUS.fail : checked.length ? STATUS.pass : STATUS.unavailable;
      add(
        status,
        scenario,
        id,
        title,
        items.flatMap((item) => item.evidence.map((line) => `${item.label}: ${line}`)),
      );
    },
  };
}

export const outcome = (label, status, ...evidence) => ({ label, status, evidence });

const MINUTE_MS = 60_000;
const PRESSURE_IDLE_MS = 2 * MINUTE_MS;

// stim status rounds lastActivityAt down to the minute, so real activity may be up to a minute later than it reports.
export function judgeIdleTiming({
  commandEndMs,
  lastActivityMs,
  readAtMs,
  windowMs,
  tickMs,
  previousPollStartMs,
  idlePollStartMs,
  idlePollEndMs,
  pressureLevel = null,
}) {
  const reported = lastActivityMs === null ? commandEndMs : Math.min(readAtMs, lastActivityMs + MINUTE_MS);
  const t0 = Math.max(commandEndMs, reported);
  const deadline = t0 + windowMs + tickMs;
  const late = previousPollStartMs !== null && previousPollStartMs > deadline;
  const earliest = commandEndMs + windowMs - tickMs;
  const early = idlePollEndMs < earliest;
  const idleFor = idlePollEndMs - t0;
  const earlyAllowed =
    early && (pressureLevel === 'high' || pressureLevel === 'critical') && idleFor >= PRESSURE_IDLE_MS;
  return {
    ok: !late && (!early || earlyAllowed),
    early,
    earlyAllowed,
    t0,
    deadline,
    earliest,
    evidence: [
      `last activity at or before ${clock(t0)} (command ended ${clock(commandEndMs)}${
        lastActivityMs === null ? '' : `, status activity ${clock(lastActivityMs)} to the minute`
      })`,
      `window ${Math.round(windowMs / MINUTE_MS)} min + tick ${Math.round(tickMs / 1000)} s gives deadline ${clock(deadline)}`,
      `previous poll still working at ${previousPollStartMs === null ? 'none' : clock(previousPollStartMs)}, first idle poll ${clock(idlePollStartMs)} to ${clock(idlePollEndMs)}`,
      ...(early
        ? [
            `idle before ${clock(earliest)}, the end of the last command plus the window minus one tick; ${
              earlyAllowed
                ? `allowed: the build's status reported ${pressureLevel} pressure and the workspace had been idle ${Math.round(idleFor / 1000)} s`
                : `not allowed: the build's status reported ${pressureLevel ?? 'no'} pressure level and the workspace had been idle ${Math.round(idleFor / 1000)} s (a pressure idle needs high or critical and 2 minutes)`
            }`,
          ]
        : []),
    ],
  };
}
