# Desktop timestamp benchmark

Measured for [#4603](https://github.com/appandflow/stim/issues/4603) on October 29, 2026. [Raw measurements](./desktop-timestamps-2026-10-29.json) retain every repetition.

The production `Overview.idleProjects` calculation over 100 idle workspaces, each with two failed platform builds, takes a warm median of 18.72 ms per pass on baseline `c842988ac` and 1.09 ms with the timestamp fast path. A repeated before/after pair gives 19.91 ms and 1.15 ms. Both pairs produce the same checksum. Each launch runs six repetitions of 20 passes; the warm summary excludes the first repetition in both variants.

This is model time in a Debug app on Mac16,10 with 16 GB RAM, macOS 27.0 (26A428), Apple Swift 6.4.0.34.1. Fixture construction, app build/launch and accessibility traversal are outside the interval. The second pair overlaps isolated Swift test compilation (load about 5 on 10 cores); it is retained separately. These numbers do not measure screen time-to-visible, scrolling or whole-app CPU. The hosted test home has no server; no real server or capture workload is claimed.

## Reproduce

Use an owned worktree for each variant. For the baseline, use `c842988ac`. For the changed variant, retain the timestamp fast path. Add this temporary DEBUG probe at `apps/desktop/Sources/StimDesktop/Design/BenchmarkProbe.swift`:

```swift
#if DEBUG
import Foundation
import StimKit

enum BenchmarkProbe {
  static func run() {
    guard ProcessInfo.processInfo.arguments.contains("--benchmark-overview") else { return }
    let environments: [Workspace] = (0..<100).map { index in
      let json = """
      {"path":"/Benchmark/project-\(index)","live":false,"warnings":[],"lastBuilds":{
        "ios":{"platform":"ios","cacheHit":false,"status":"failed","startedAt":"2026-10-29T12:00:00.123Z","finishedAt":"2026-10-29T12:01:00.456Z"},
        "android":{"platform":"android","cacheHit":false,"status":"failed","startedAt":"2026-10-29T13:00:00.789Z","finishedAt":"2026-10-29T13:01:00.012Z"}
      }}
      """
      return try! JSONDecoder().decode(Workspace.self, from: Data(json.utf8))
    }
    let project: (String) -> Project = { Project(root: $0) }
    let summaries = projectSummaries(environments: environments, unprovisioned: [], project: project)
    for repetition in 0..<6 {
      let began = ProcessInfo.processInfo.systemUptime
      var checksum = 0.0
      for _ in 0..<20 {
        let items = Overview.idleProjects(summaries: summaries, environments: environments, project: project)
        checksum += items.reduce(0) { $0 + ($1.lastActivity?.timeIntervalSince1970 ?? 0) }
      }
      let ms = (ProcessInfo.processInfo.systemUptime - began) * 1000
      print("MODEL_BENCHMARK {\"repetition\":\(repetition),\"workspaces\":100,\"passes\":20,\"wallMs\":\(ms),\"checksum\":\(checksum)}")
    }
  }
}
#endif

```

Call `BenchmarkProbe.run()` at the start of `ScreenPlaygroundApp.init()` in `Design/ScreenPlayground.swift`. Append `--playground` and `--benchmark-overview` to the existing `macos.arguments` in `apps/desktop/.stim.json`. From that directory, run:

```sh
stim macos --remote-build janics-mac-mini --remote janics-mac-mini --json
stim logs --source client --json
```

Extract the six `MODEL_BENCHMARK` records for that launch's run ID. Divide each `wallMs` by 20 for time per model pass. Compare checksums and distributions before interpreting the median. Repeat both variants on the same host/toolchain and record concurrent load. Keep the source instrumentation and fixture identical between variants; change only the timestamp implementation. Use `stim stop` for the owned app, remove the temporary probe/call/arguments, and remove only the owned worktree when finished.
