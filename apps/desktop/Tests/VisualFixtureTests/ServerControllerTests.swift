import Foundation
import StimKit
import XCTest

@testable import StimDesktop

@MainActor final class ServerControllerTests: XCTestCase {
  func testNotReadyServerKeepsOwnershipWithoutAdoptingAHome() {
    for owned in [false, true] {
      for startup in [ServerStartup.pending, .degraded("Volume is stalled.")] {
        let state = ServerController.State(
          probe: .notReady(startup), owned: owned, resolvedHome: "/custom/stim", port: 7787)
        XCTAssertEqual(state, .notReady(startup, owned: owned))
      }
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
