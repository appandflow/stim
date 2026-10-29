import Foundation
import StimKit
import XCTest

@testable import StimDesktop

@MainActor final class ServerControllerTests: XCTestCase {
  func testOnlyAnUnconfiguredLoopbackServerMovesAsideForAnotherStimHome() throws {
    let health = try JSONDecoder().decode(
      ServerHealth.self,
      from: Data(
        #"{"server":"stim-server","name":"Mac","version":"1","stim":"1","protocol":2,"stimHome":"/server/stim","tailscale":{"state":"running"}}"#
          .utf8))
    let probes = [
      ServerHealthProbe.ready(health), .notReady(.pending, stimHome: "/server/stim"),
      .notReady(.degraded("Volume is stalled."), stimHome: "/server/stim"),
    ]
    for probe in probes {
      XCTAssertTrue(
        ServerController.needsAutomaticPort(
          probe: probe, resolvedHome: "/custom/stim", loopbackOnly: true, explicitPort: false))
      XCTAssertFalse(
        ServerController.needsAutomaticPort(
          probe: probe, resolvedHome: "/server/stim", loopbackOnly: true, explicitPort: false))
      XCTAssertFalse(
        ServerController.needsAutomaticPort(
          probe: probe, resolvedHome: "\(NSHomeDirectory())/.stim", loopbackOnly: true, explicitPort: false))
      XCTAssertFalse(
        ServerController.needsAutomaticPort(
          probe: probe, resolvedHome: "/custom/stim", loopbackOnly: false, explicitPort: false))
      XCTAssertFalse(
        ServerController.needsAutomaticPort(
          probe: probe, resolvedHome: "/custom/stim", loopbackOnly: true, explicitPort: true))
    }
    XCTAssertFalse(
      ServerController.needsAutomaticPort(
        probe: .notReady(.pending, stimHome: nil), resolvedHome: "/custom/stim", loopbackOnly: true, explicitPort: false))
  }

  func testAnAutomaticPortUsesOnlyTheChildsLoopbackListenerAnnouncement() {
    XCTAssertEqual(ServerController.announcedLoopbackPort(OutputLine(.stdout, "listening on ws://127.0.0.1:49152")), 49152)
    XCTAssertNil(ServerController.announcedLoopbackPort(OutputLine(.stderr, "listening on ws://127.0.0.1:49152")))
    for line in [
      "listening on ws://100.72.66.29:49152", "listening on ws://127.0.0.1:0",
      "listening on ws://127.0.0.1:65536", "listening on ws://127.0.0.1:49152/health",
    ] {
      XCTAssertNil(ServerController.announcedLoopbackPort(OutputLine(.stdout, line)))
    }
  }

  func testNotReadyExternalServerRequiresTheResolvedHomeWhenKnown() {
    for startup in [ServerStartup.pending, .degraded("Volume is stalled.")] {
      let matching = ServerController.State(
        probe: .notReady(startup, stimHome: "/server/stim"), owned: false, resolvedHome: "/server/stim", port: 7787)
      XCTAssertEqual(matching, .notReady(startup, owned: false))
      let unknown = ServerController.State(
        probe: .notReady(startup, stimHome: nil), owned: false, resolvedHome: "/custom/stim", port: 7787)
      XCTAssertEqual(unknown, .notReady(startup, owned: false))
      let mismatched = ServerController.State(
        probe: .notReady(startup, stimHome: "/server/stim"), owned: false, resolvedHome: "/custom/stim", port: 7787)
      guard case .failed(let reason) = mismatched else {
        XCTFail("A not-ready server with a different custom home must not be adopted")
        return
      }
      XCTAssertTrue(reason.contains("stim-server on port 7787 uses /server/stim, but this Desktop uses /custom/stim."))
      let owned = ServerController.State(
        probe: .notReady(startup, stimHome: "/server/stim"), owned: true, resolvedHome: "/custom/stim", port: 7787)
      XCTAssertEqual(owned, .notReady(startup, owned: true))
    }
  }

  func testStartupKeepsProbingUntilReadyAndPreservesNotReadyServerAtDeadline() throws {
    XCTAssertEqual(ServerController.StartupAction(lastAnswer: nil, deadlinePassed: false), .retry)
    XCTAssertEqual(ServerController.StartupAction(lastAnswer: nil, deadlinePassed: true), .fail)
    for startup in [ServerStartup.pending, .degraded("Volume is stalled.")] {
      let answer = ServerHealthProbe.notReady(startup, stimHome: "/server/stim")
      XCTAssertEqual(ServerController.StartupAction(lastAnswer: answer, deadlinePassed: false), .retry)
      XCTAssertEqual(ServerController.StartupAction(lastAnswer: answer, deadlinePassed: true), .handOver)
    }
    let health = try JSONDecoder().decode(
      ServerHealth.self,
      from: Data(
        #"{"server":"stim-server","name":"Mac","version":"1","stim":"1","protocol":1,"stimHome":"/server/stim","tailscale":{"state":"running"}}"#
          .utf8))
    for deadlinePassed in [false, true] {
      XCTAssertEqual(ServerController.StartupAction(lastAnswer: .ready(health), deadlinePassed: deadlinePassed), .handOver)
    }
  }

  func testReadyExternalServerStillRequiresTheResolvedHome() throws {
    let health = try JSONDecoder().decode(
      ServerHealth.self,
      from: Data(
        #"{"server":"stim-server","name":"Mac","version":"1","stim":"1","protocol":1,"stimHome":"/server/stim","tailscale":{"state":"running"},"startup":{"state":"ready"}}"#
          .utf8))
    let matching = ServerController.State(
      probe: .ready(health), owned: false, resolvedHome: "/server/stim", port: 7787)
    XCTAssertEqual(matching, .running(health, owned: false))
    let mismatched = ServerController.State(
      probe: .ready(health), owned: false, resolvedHome: "/custom/stim", port: 7787)
    guard case .failed(let reason) = mismatched else {
      XCTFail("A ready server with a different custom home must not be adopted")
      return
    }
    XCTAssertTrue(reason.contains("/server/stim") && reason.contains("/custom/stim"))
    let owned = ServerController.State(
      probe: .ready(health), owned: true, resolvedHome: "/custom/stim", port: 7787)
    XCTAssertEqual(owned, .running(health, owned: true))
  }
}
