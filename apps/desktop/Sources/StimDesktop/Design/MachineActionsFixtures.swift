#if DEBUG
  import StimKit
  import StimStores
  import SwiftUI

  struct MachineActionsPlayground: View {
    var scenario: PlaygroundScenario
    @State private var status: StatusStore?
    @State private var gc: GcReportStore?
    @State private var metrics: MetricsStore?
    @State private var failure: String?

    var body: some View {
      ScrollView {
        if let status, let gc, let metrics {
          NowBand(status: status, metrics: metrics, gc: gc)
        } else if let failure {
          EmptyState(title: "Fixture unavailable", message: failure)
        } else {
          ProgressView()
        }
      }
      .padding(Space.xl)
      .onAppear {
        do {
          var payload = try JSONDecoder().decode(StatusPayload.self, from: Data(#"{"environments":[]}"#.utf8))
          payload.machine = MachineUsage(
            memorySource: .footprint,
            owners: scenario == .empty
              ? []
              : [
                MachineOwner(kind: .shared, name: "Watchman", cpuPercent: 1, memoryMb: 1024),
                MachineOwner(kind: .shared, name: "Gradle daemon", cpuPercent: 0, memoryMb: 768),
                MachineOwner(
                  kind: .metro, name: "Metro", workspace: PlaygroundFixtures.workspace, owned: true,
                  cpuPercent: 12, memoryMb: 256),
                MachineOwner(
                  kind: .simulator, name: "iPhone 17 Pro", workspace: PlaygroundFixtures.workspace, slot: "review", owned: true,
                  cpuPercent: 5, memoryMb: 128),
                MachineOwner(kind: .simulator, name: "Personal simulator", owned: false, memoryMb: 64),
              ])
          let available = scenario != .error
          let report = try JSONDecoder().decode(
            GcReport.self,
            from: Data(
              """
              {"sections":{"memory":[
                {"kind":"watchman","cacheKind":"watchman","pid":41,"bytes":1073741824,
                 "reclaimable":\(available),"detail":"Used by Metro in the review workspace"},
                {"kind":"gradleDaemon","cacheKind":"gradle-daemons","pid":42,"bytes":805306368,
                 "reclaimable":\(available),"detail":"A build is still using this daemon"}
              ]}}
              """.utf8))
          let status = StatusStore(fixture: payload)
          let gc =
            scenario == .loading
            ? GcReportStore(reader: GcReportReader(environment: Task { [String: String]() }, server: { nil }))
            : GcReportStore(fixture: report)
          self.status = status
          self.gc = gc
          metrics = MetricsStore(status: status, gc: gc, disks: DiskVolumeStore(status: status))
        } catch {
          failure = error.localizedDescription
        }
      }
    }
  }
#endif
