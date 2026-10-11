import Foundation
import Testing

@testable import StimKit

private func workspace(_ path: String, phase: String? = nil) throws -> Workspace {
  let build =
    phase.map {
      #","build":{"platform":"ios","slot":"default","state":"running","phase":"\#($0)","startedAt":"2026-10-10T10:00:00.000Z","phaseStartedAt":"2026-10-10T10:01:00.000Z","basis":0}"#
    } ?? ""
  return try JSONDecoder().decode(
    Workspace.self, from: Data(#"{"path":"\#(path)","live":true,"warnings":[]\#(build)}"#.utf8))
}

@Test func workspaceArrivalsReportEachNewWorkspaceOnceAndNotTheOnesListedAtLaunch() throws {
  var arrivals = WorkspaceArrivals()
  #expect(arrivals.update([try workspace("/a", phase: "compile")]).isEmpty)

  let first = arrivals.update([try workspace("/a"), try workspace("/b")])
  #expect(first.map(\.path) == ["/b"])

  #expect(arrivals.update([try workspace("/a"), try workspace("/b", phase: "wait")]).isEmpty)
  #expect(arrivals.update([try workspace("/a"), try workspace("/b", phase: "compile")]).isEmpty)
  #expect(arrivals.update([try workspace("/a")]).isEmpty)
  #expect(arrivals.update([try workspace("/a"), try workspace("/b")]).isEmpty)
}

@Test func workspaceArrivalCardSaysBuildingOnlyWhileTheBuildRuns() throws {
  #expect(WorkspaceArrivals.buildLine(try workspace("/a", phase: "prebuild")) == "Building iOS")
  #expect(WorkspaceArrivals.buildLine(try workspace("/a")) == nil)
}
