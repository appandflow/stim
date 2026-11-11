# Campaign timing history

Keep one timing-only snapshot after a complete campaign, not after individual
cells or retries. `rc.json` captures the preceding published comparison;
`1.0.0.json` captures the full replacement campaign. These are single observations,
not repeated-sample estimates; changes in agents, fixtures, and harnesses mean
differences are not attributable solely to the Stim version.

The clock starts at the first recorded agent activity. Readiness ends at the
validated Settings screenshot. Launch-failure cells additionally record the first
actionable diagnosis. All values are seconds, retaining the source precision.
History contains no transcripts, paths, recordings, token counts, or costs.

Before replacing the website's canonical datasets, archive the completed set:

```sh
node scripts/snapshot-benchmark-times.mjs <campaign> website/src/data/benchmarks docs/benchmark-history/<campaign>.json
```

The snapshot command requires every model/platform/scenario/arm cell the benchmark matrix lists (`website/src/data/benchmark-matrix.json`; a React Native dataset's `fixture` field and a native pair's platform and backend select the row),
valid finite timings, and first-activity timing metadata. It refuses to overwrite
an existing snapshot. Run evidence must already have passed the benchmark export
audit; this command checks campaign completeness, not raw run validity.

Publish the new canonical datasets and their current proof files only after the
whole replacement campaign passes the audit, then snapshot that complete set.
Do not archive individual failed attempts here.

Snapshots written by the current script use `schemaVersion` 3: each run has
`seconds` and `timingOrigin` (`first-agent-activity` for React Native datasets,
`dispatch-to-completed-task` for native pairs) instead of `settingsReadySeconds`
and a file-level origin. `rc.json` and `1.0.0.json` stay schema 1; nothing in the
repository reads these files, so they are unaffected.
