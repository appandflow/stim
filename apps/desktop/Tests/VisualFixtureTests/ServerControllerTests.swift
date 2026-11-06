import Foundation
import StimKit
import XCTest

@testable import StimDesktop

@MainActor final class ServerControllerTests: XCTestCase {
  func testARunningServerThatRefusesDesktopsConnectionIsAProblemButAStartingOneIsNot() throws {
    let health = try JSONDecoder().decode(
      ServerHealth.self,
      from: Data(
        #"{"server":"stim-server","name":"Mac","version":"1","stim":"1","protocol":2,"stimHome":"/server/stim","tailscale":{"state":"running"}}"#
          .utf8))
    let refusal = "The Stim engine 1.42.0 is older than Stim Desktop; run stim engine update"
    XCTAssertEqual(
      ServerController.problem(state: .running(health, owned: true), connectionRefusal: refusal), refusal)
    XCTAssertNil(ServerController.problem(state: .running(health, owned: true), connectionRefusal: nil))
    XCTAssertNil(ServerController.problem(state: .starting, connectionRefusal: refusal))
    XCTAssertEqual(
      ServerController.problem(state: .failed("Port in use."), connectionRefusal: refusal), "Port in use.")
  }

  func testStartupUsesOnlyALiveRecordAndWaitsForOneUntilTheDeadline() throws {
    let record = try JSONDecoder().decode(
      StimdRecord.self,
      from: Data(#"{"format":1,"pid":42,"socket":"/home/run/stimd.sock","build":"3f9a1c0d22e8","version":"1.43.0"}"#.utf8))
    let alive: (StimdRecord) -> Bool = { $0.pid == 42 }
    let dead: (StimdRecord) -> Bool = { _ in false }
    typealias Action = ServerController.StartupAction
    XCTAssertEqual(Action.decide(.found(record), alive: alive, deadlinePassed: true), .use(record))
    XCTAssertEqual(Action.decide(.found(record), alive: dead, deadlinePassed: false), .wait)
    XCTAssertEqual(Action.decide(.missing, alive: alive, deadlinePassed: false), .wait)
    XCTAssertEqual(Action.decide(.unreadable, alive: alive, deadlinePassed: false), .wait)
    XCTAssertEqual(Action.decide(.missing, alive: alive, deadlinePassed: true), .fail)
    XCTAssertEqual(Action.decide(.unknownFormat("update"), alive: alive, deadlinePassed: false), .refuse("update"))
  }
}
