# perf-data

Benchmark results for Stim releases. This branch has no shared history with `main` and holds only data. The
harness that writes it is `scripts/perf/bench.mjs` on `main`; see `docs/perf.md` there. It is not part of the
release gate.

## Layout

```text
runs/<machine id>/<UTC start time>-<stim version or local-sha>.json
```

One file per `bench.mjs` run. The machine id is the hardware model plus a short hash of the host name; the files hold no host name, user name
or path. Files are never edited after they are pushed.

## File format (schema 1)

```text
schema, id, startedAt, finishedAt     id is the file name without .json
stim        { source: npm | path, label, version, traceSupport }
repo        { sha }                    the commit whose apps/mobile the scenarios ran
machine     { id, model, cpu, cores, memoryGb, os, xcode, node }
config      { reps, primed, app, maxLoad }
load        { start: [1m, 5m, 15m], end: [1m, 5m, 15m] }
scenarios   { <name>: { runs: [...], summary } }
skipped     [{ scenario, reason }]
```

`stim.label` is the npm version, or `local-<version>-<repo sha or external>` for a local build. `config.primed` is
true when an unmeasured pass filled the build caches first; primed and unprimed runs are never compared.

A scenario run is `{ rep, wallMs, exit, loadBefore, loadAfter }` plus, when present:

- `trace`: `{ commandMs, phases, spans, exec: { count, ms } }` summed from the `STIM_TRACE` file (Stim versions
  with `STIM_TRACE` only). `phases` are the build phases named as in stats.json. `traceUnreadable: true` replaces
  it when the file could not be parsed.
- `statsPhases`: for a successful ios or android run of a Stim version without `STIM_TRACE`, the phases stats.json
  recorded in the run's time window when exactly one sample matches. A heuristic.
- `failure`: `exit`, `signal` or `spawn` for a run that did not succeed. No output text is stored.

Scenarios: `warm`, `start`, `ios-first`, `ios-rerun`, `android-first`, `android-rerun`, `stop`. The `first`
scenario is the first run in a new worktree (device setup and cache restore); `rerun` is the second run with the
app installed. All times are milliseconds. `summary` is `{ n, failures, medianMs, minMs, maxMs, spread }` over the
successful repetitions.

## Comparing

```sh
node scripts/perf/compare.mjs
```

from a checkout of `main` prints the latest run of each machine against the run before it. Timings taken under
very different load are not compared.
