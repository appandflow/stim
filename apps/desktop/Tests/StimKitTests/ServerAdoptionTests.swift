import Foundation
import Testing

@testable import StimKit

@Suite struct ServerAdoptionTests {
  private func health(home: String, version: String = "1.20.1") throws -> ServerHealth {
    try JSONDecoder().decode(
      ServerHealth.self,
      from: Data(
        #"{"server":"stim-server","name":"Mac","version":"\#(version)","stim":"1","protocol":1,"stimHome":"\#(home)","tailscale":{"state":"running"}}"#
          .utf8))
  }

  @Test func provisionalHomePrefersLaunchHomeThenLastLoginHome() {
    #expect(
      ServerAdoption.provisionalHome(
        launch: ["STIM_HOME": "/launch"], lastLoginHome: "/login", home: "/Users/me") == "/launch")
    #expect(ServerAdoption.provisionalHome(launch: [:], lastLoginHome: "/login", home: "/Users/me") == "/login")
    #expect(
      ServerAdoption.provisionalHome(
        launch: ["STIM_HOME": "relative"], lastLoginHome: nil, home: "/Users/me") == "/Users/me/.stim")
  }

  @Test func provisionalAdoptionTakesOnlyAReadyServerForTheExpectedHome() throws {
    let custom = try health(home: "/tmp/custom")
    #expect(
      ServerAdoption.provisional(.ready(custom), provisionalHome: "/tmp/custom", home: "/Users/me") == custom)
    #expect(ServerAdoption.provisional(.ready(custom), provisionalHome: "/tmp/other", home: "/Users/me") == nil)
    #expect(
      ServerAdoption.provisional(
        .notReady(.pending, stimHome: "/tmp/custom"), provisionalHome: "/tmp/custom", home: "/Users/me") == nil)
  }

  @Test func loginHomeFromTheShellProfileDropsAServerAdoptedForTheDefaultHome() throws {
    let adopted = try health(home: "/Users/me/.stim")
    #expect(
      ServerAdoption.provisional(.ready(adopted), provisionalHome: "/Users/me/.stim", home: "/Users/me") == adopted)
    #expect(
      ServerAdoption.confirmed(
        adopted: adopted, probe: .ready(adopted), loginHome: "/Users/me/profile-stim", home: "/Users/me") == nil)
    #expect(
      ServerAdoption.confirmed(
        adopted: adopted, probe: .ready(adopted), loginHome: "/Users/me/.stim", home: "/Users/me") == adopted)
  }

  @Test func confirmationNeedsTheSameServerStillReady() throws {
    let adopted = try health(home: "/tmp/custom")
    let cases: [ServerHealthProbe?] = [
      nil,
      .notReady(.pending, stimHome: "/tmp/custom"),
      .ready(try health(home: "/tmp/other")),
      .ready(try health(home: "/tmp/custom", version: "1.21.0")),
    ]
    for probe in cases {
      #expect(ServerAdoption.confirmed(adopted: adopted, probe: probe, loginHome: "/tmp/custom", home: "/Users/me") == nil)
    }
  }

  @MainActor @Test func writesWaitForAProvisionalAdoptionAndFollowItsOutcome() async {
    for outcome in [ServerAdoption.verified(home: "/tmp/custom"), .none] {
      let gate = ServerAdoptionGate()
      gate.set(.provisional(home: "/tmp/custom"))
      #expect(!gate.allowsWrites(home: "/tmp/custom"))
      var allowed: Bool?
      let write = Task { @MainActor in
        await gate.settled()
        allowed = gate.allowsWrites(home: "/tmp/custom")
      }
      for _ in 0..<5 { await Task.yield() }
      #expect(allowed == nil)
      gate.set(outcome)
      await write.value
      #expect(allowed == (outcome != .none))
      #expect(!gate.allowsWrites(home: "/tmp/other"))
    }
  }
}
