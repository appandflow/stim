# perf-data

Benchmark results for Stim releases. This branch has no shared history with `main` and holds only data. The
harness that writes it is `scripts/perf/bench.mjs` on `main`; see `docs/perf.md` there. It is not part of the
release gate.

## Layout

```text
runs/<machine id>/<UTC start time>-<stim version or local-sha>.json
```

One file per `bench.mjs` run. The machine id is the hardware model plus a short hash of the host name, so no host
name or user name is stored. Files are never edited after they are pushed.

## File format (schema 1)

```text
schema, startedAt, finishedAt
stim        { source: npm | path, label, version, traceSupport }
repo        { sha, branch, appDirty }      the commit whose apps/mobile the scenarios ran
machine     { id, model, cpu, cores, memoryGb, os, xcode, node }
config      { reps, primed, app, maxLoad }
load        { start: [1m, 5m, 15m], end: [1m, 5m, 15m] }
scenarios   { <name>: { runs: [...], summary } }
skipped     [{ scenario, reason }]
```

A scenario run is `{ rep, wallMs, exit, loadBefore, loadAfter }` plus, when present:

- `trace`: `{ commandMs, phases, spans, exec: { count, ms } }` summed from the `STIM_TRACE` file (Stim versions
  with `STIM_TRACE` only). `phases` are the build phases named as in stats.json.
- `statsPhases`: the phases stats.json recorded for that ios or android run.
- `error`: the end of the output of a failed run, with home and temporary paths replaced.

Scenarios: `warm`, `start`, `ios-first`, `ios-rerun`, `android-first`, `android-rerun`, `stop`. The `first`
scenario is the first run in a new worktree (device setup and cache restore); `rerun` is the second run with the
app installed. All times are milliseconds.

## Comparing

```sh
node scripts/perf/compare.mjs
```

from a checkout of `main` prints the latest run of each machine against the run before it. Timings taken under
very different load are not compared.
