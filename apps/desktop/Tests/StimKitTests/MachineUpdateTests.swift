import Foundation
import Testing

@testable import StimKit

@Suite struct MachineUpdateTests {
  private func status(_ json: String) throws -> MachineUpdateStatus {
    try JSONDecoder().decode(MachineUpdateStatus.self, from: Data(json.utf8))
  }

  private let started = "2026-10-05T22:00:00.000Z"

  @Test func followsAnUpdateFromUploadThroughRestartToItsOutcome() throws {
    let sending = try status(#"{"remote":null,"unreachable":null,"upload":{"sent":1024,"total":4096,"error":null}}"#)
    #expect(MachineUpdatePhase.from(sending, startedAt: started) == .sending(0.25))

    let installing = try status(
      #"""
      {"remote":{"server":{"version":"1.14.0","stimBuild":"a"},"service":"dev.stim.server","acceptsClientBuilds":true,
        "running":{"id":"u","by":{"id":"c","name":"Laptop"},"target":"packages from Laptop","state":"installing",
          "startedAt":"2026-10-05T22:00:00.000Z","missing":[],"log":["Installing 5 package file(s).","Switching dev.stim.server."]},
        "last":{"at":"2026-10-04T10:00:00.000Z","target":"release 1.13.0","ok":true,"message":"older outcome"}},
       "unreachable":null,"upload":{"sent":4096,"total":4096,"error":null}}
      """#)
    #expect(MachineUpdatePhase.from(installing, startedAt: started) == .installing("Switching dev.stim.server."))

    let restarting = try status(#"{"remote":null,"unreachable":"the host connection closed","upload":null}"#)
    #expect(MachineUpdatePhase.from(restarting, startedAt: started) == .restarting)

    let done = try status(
      #"""
      {"remote":{"server":{"version":"1.14.0","stimBuild":"b"},"service":"dev.stim.server","acceptsClientBuilds":true,
        "running":null,"last":{"at":"2026-10-05T22:00:03.000Z","target":"x","ok":true,"message":"dev.stim.server now runs stim-server 1.14.0."}},
       "unreachable":null,"upload":null}
      """#)
    #expect(MachineUpdatePhase.from(done, startedAt: started) == .finished("dev.stim.server now runs stim-server 1.14.0."))
  }

  @Test func treatsAnOutcomeOlderThanTheRequestAsNotYetFinished() throws {
    let stale = try status(
      #"""
      {"remote":{"server":{"version":"1.14.0","stimBuild":"a"},"service":"dev.stim.server","acceptsClientBuilds":false,
        "running":null,"last":{"at":"2026-10-04T10:00:00.000Z","target":"x","ok":false,"message":"an earlier failure"}},
       "unreachable":null,"upload":null}
      """#)
    #expect(MachineUpdatePhase.from(stale, startedAt: started) == .restarting)
  }

  @Test func failsOnAnUploadErrorOrAFailedOutcome() throws {
    let refused = try status(
      #"{"remote":null,"unreachable":null,"upload":{"sent":10,"total":20,"error":"stim-server.tgz does not match the sha256 it offered."}}"#
    )
    #expect(
      MachineUpdatePhase.from(refused, startedAt: started) == .failed("stim-server.tgz does not match the sha256 it offered."))
    let failed = try status(
      #"""
      {"remote":{"server":{"version":"1.14.0","stimBuild":"a"},"service":"dev.stim.server","acceptsClientBuilds":true,
        "running":null,"last":{"at":"2026-10-05T22:01:00.000Z","target":"x","ok":false,"message":"did not answer. Switched back."}},
       "unreachable":null,"upload":null}
      """#)
    #expect(MachineUpdatePhase.from(failed, startedAt: started) == .failed("did not answer. Switched back."))
  }

  @Test func offersAnUpdateOnlyForAnApprovedMachineOnAnotherStimBuild() throws {
    let report = try JSONDecoder().decode(
      DoctorReport.self,
      from: Data(
        #"""
        {"project":"/p","findings":[],"buildMachines":[
          {"machine":"mini","state":"approved","offloadable":false,"reasons":["Stim build a there, b here"],
           "problems":[{"code":"stim-build","reason":"Stim build a there, b here"}]},
          {"machine":"studio","state":"approved","offloadable":false,"problems":[{"code":"xcode","reason":"Xcode differs"}]},
          {"machine":"old","state":"revoked","problems":[{"code":"stim-build","reason":"x"}]}]}
        """#.utf8))
    #expect(try #require(report.buildMachines).map(needsStimUpdate) == [true, false, false])
  }
}
