import Foundation
import Testing

@testable import StimKit

@Suite struct MaintenanceStatusTests {
  private func payload(_ maintenance: String?) throws -> StatusPayload {
    let block = maintenance.map { ",\"maintenance\":\($0)" } ?? ""
    return try JSONDecoder().decode(StatusPayload.self, from: Data("{\"environments\":[]\(block)}".utf8))
  }

  @Test func onWithoutProblemsCleansAutomatically() throws {
    let status = try payload(
      #"{"mode":"on","lastPass":{"startedAt":1791256709802,"mode":"on","freedBytes":1288490188,"actions":3,"blocked":[]}}"#
    ).maintenance
    #expect(status?.cleansAutomatically == true)
    #expect(status?.lastPassLine?.contains("3 actions") == true)
  }

  @Test func reportOffInvalidAndBlockedLeaveCleanupToTheApp() throws {
    for block in [
      #"{"mode":"report"}"#, #"{"mode":"off"}"#, #"{"mode":"on","invalid":"maintenance.mode: bad"}"#,
      #"{"mode":"on","claim":{"unresolved":"x","removeCommand":"y"}}"#,
    ] {
      #expect(try payload(block).maintenance?.cleansAutomatically == false, "\(block)")
    }
  }

  @Test func anOlderStimOrAMalformedBlockReportsNoMaintenance() throws {
    #expect(try payload(nil).maintenance == nil)
    #expect(try payload(#"{"mode":5}"#).maintenance == nil)
  }

  @Test func theAppRemovesFinishedWorktreesWhenTheCliWorktreeCheckIsStale() throws {
    let now = Date(timeIntervalSince1970: 1_791_256_709)
    func status(_ lastChecks: String) throws -> MaintenanceStatus? {
      try payload(#"{"mode":"on","lastChecks":\#(lastChecks)}"#).maintenance
    }
    #expect(try status(#"{"worktree":1791256000000}"#)?.removesFinishedWorktrees(now: now) == true)
    #expect(try status(#"{"worktree":1791240000000}"#)?.removesFinishedWorktrees(now: now) == false)
    #expect(try status(#"{"worktree":null}"#)?.removesFinishedWorktrees(now: now) == false)
  }

  @Test func theCliPressureBlockCarriesMemoryCulpritsWithoutDroppingMaintenance() throws {
    let status = try payload(
      #"{"mode":"on","pressure":{"disk":[{"volume":"/","freeMb":90000}],"memory":{"level":"critical","availableBytes":null,"pressured":true,"culprits":[{"pid":76886,"name":"fseventsd","bytes":67645734912,"command":"sudo killall fseventsd","note":"launchd restarts it."},{"pid":4411,"name":"Xcode","bytes":13958643712,"command":null,"note":null}]},"warningSince":null}}"#
    ).maintenance
    #expect(status?.cleansAutomatically == true)
    #expect(status?.memoryCulprits.map(\.name) == ["fseventsd", "Xcode"])
    #expect(status?.memoryCulprits.first?.command == "sudo killall fseventsd")
    #expect(try payload(#"{"mode":"on","pressure":null}"#).maintenance?.memoryCulprits.isEmpty == true)
  }

  @Test func aReportPassHasNoSummaryLine() throws {
    let status = try payload(
      #"{"mode":"report","lastPass":{"startedAt":1,"mode":"report","freedBytes":0,"actions":2,"blocked":[]}}"#
    ).maintenance
    #expect(status?.lastPassLine == nil)
  }
}
