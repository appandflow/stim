import Foundation
import Testing

@testable import StimKit

@Suite struct MaintenanceStatusTests {
  private func payload(_ maintenance: String?) throws -> StatusPayload {
    let block = maintenance.map { ",\"maintenance\":\($0)" } ?? ""
    return try JSONDecoder().decode(StatusPayload.self, from: Data("{\"environments\":[]\(block)}".utf8))
  }

  @Test func anOlderStimOrAMalformedBlockReportsNoMaintenance() throws {
    #expect(try payload(nil).maintenance == nil)
    #expect(try payload(#"{"mode":5}"#).maintenance == nil)
  }

  @Test func theCliPressureBlockCarriesMemoryCulpritsWithoutDroppingMaintenance() throws {
    let status = try payload(
      #"{"mode":"on","pressure":{"disk":[{"volume":"/","freeMb":90000}],"memory":{"level":"critical","availableBytes":null,"pressured":true,"culprits":[{"pid":76886,"name":"fseventsd","bytes":67645734912,"command":"sudo killall fseventsd","note":"launchd restarts it."},{"pid":4411,"name":"Xcode","bytes":13958643712,"command":null,"note":null}]},"warningSince":null}}"#
    ).maintenance
    #expect(status?.memoryCulprits.map(\.name) == ["fseventsd", "Xcode"])
    #expect(status?.memoryCulprits.first?.command == "sudo killall fseventsd")
    #expect(try payload(#"{"mode":"on","pressure":null}"#).maintenance?.memoryCulprits.isEmpty == true)
  }
}
