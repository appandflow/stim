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

@Test func workspaceArrivalsSkipTemporaryFolders() throws {
  var arrivals = WorkspaceArrivals()
  _ = arrivals.update([try workspace("/a")])
  let arrived = arrivals.update([
    try workspace("/a"), try workspace("/tmp/scratch"), try workspace("/private/tmp/scratch2"),
    try workspace("/var/folders/ab/cd/T/wt"), try workspace("/private/var/folders/ab/cd/T/wt2"),
    try workspace("/tmpfiles/real"), try workspace("/Users/me/tmp/real"),
  ])
  #expect(arrived.map(\.path) == ["/tmpfiles/real", "/Users/me/tmp/real"])
}
