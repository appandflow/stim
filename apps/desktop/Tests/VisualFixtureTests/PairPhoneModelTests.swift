import Foundation
import StimKit
import XCTest

@testable import StimDesktop

final class PairPhoneModelTests: XCTestCase {
  @MainActor private final class Harness {
    var now = Date(timeIntervalSince1970: 1_791_284_400)
    var snapshot = PairPhoneModel.Snapshot(server: .off)
    var devices: [PairedDevice] = []
    var starts = 0
    var stops = 0
    var refreshes = 0
    var reloads = 0
    var tailscaleReads = 0
    var replies = 0
    var routeReply: CheckedContinuation<String?, Never>?
    var requests: [(Bool, CheckedContinuation<PairingCode, Error>)] = []

    func make() -> PairPhoneModel {
      PairPhoneModel(
        servesPhones: false,
        dependencies: .init(
          tailscale: {
            self.tailscaleReads += 1
            return .running(dnsName: "macbook.tail.test")
          }, snapshot: { self.snapshot }, refreshServer: { self.refreshes += 1 },
          reloadDevices: { self.reloads += 1 }, devices: { self.devices }, startServing: { self.starts += 1 },
          stopServing: { self.stops += 1 },
          setUpRoute: { await withCheckedContinuation { self.routeReply = $0 } },
          pair: { control in
            let code: PairingCode = try await withCheckedThrowingContinuation { self.requests.append((control, $0)) }
            self.replies += 1
            return code
          }, now: { self.now }))
    }

    func enterPair(_ model: PairPhoneModel) {
      model.send(.tailscale(.running(dnsName: "macbook.tail.test")))
      model.send(.server(.running(tailscale: true, route: "routed", servesOtherHome: false)))
      model.send(.next)
      model.send(.next)
      model.send(.next)
    }

    func code(_ token: String) throws -> PairingCode {
      let decoder = JSONDecoder()
      decoder.dateDecodingStrategy = .secondsSince1970
      return try decoder.decode(
        PairingCode.self,
        from: Data(
          """
          {"qr":{"v":1,"name":"MacBook","endpoint":"wss://macbook.tail.test:7443","pairingToken":"\(token)"},
           "expiresAt":\(now.addingTimeInterval(300).timeIntervalSince1970)}
          """.utf8))
    }
  }

  @MainActor func testEarlierCodeCannotReplaceTheLatestCodeAfterAccessChangesBack() async throws {
    let harness = Harness()
    let model = harness.make()
    harness.enterPair(model)
    await waitUntil { harness.requests.count == 1 }
    model.send(.access(control: false))
    await waitUntil { harness.requests.count == 2 }
    model.send(.access(control: true))
    await waitUntil { harness.requests.count == 3 }
    XCTAssertEqual(harness.requests.map(\.0), [true, false, true])
    harness.requests[2].1.resume(returning: try harness.code("latest"))
    await waitUntil { model.code != nil }
    harness.requests[0].1.resume(returning: try harness.code("earlier-control"))
    harness.requests[1].1.resume(returning: try harness.code("earlier-view"))
    await waitUntil { harness.replies == 3 }
    XCTAssertEqual(model.code?.qr.pairingToken, "latest")
    XCTAssertTrue(model.wizard.control)
    XCTAssertFalse(model.wizard.requestingCode)
    model.stop()
  }

  @MainActor func testCancelStopsServingAndIgnoresAnOutstandingCodeReply() async throws {
    let harness = Harness()
    let model = harness.make()
    harness.enterPair(model)
    await waitUntil { harness.requests.count == 1 }
    XCTAssertEqual(harness.starts, 1)
    model.cancel()
    harness.requests[0].1.resume(returning: try harness.code("cancelled"))
    await waitUntil { harness.replies == 1 }
    XCTAssertEqual(harness.stops, 1)
    XCTAssertTrue(model.wizard.cancelled)
    XCTAssertNil(model.code)
  }

  @MainActor func testRouteFailureReachesTheWizardAndRetryStartsAnotherAttempt() async {
    let harness = Harness()
    let model = harness.make()
    model.send(.next)
    model.send(.tailscale(.running(dnsName: nil)))
    model.send(.next)
    model.send(.server(.running(tailscale: true, route: "missing", servesOtherHome: false)))
    await waitUntil { harness.routeReply != nil }
    let reply = harness.routeReply
    harness.routeReply = nil
    reply?.resume(returning: "Enable HTTPS")
    await waitUntil { model.wizard.routeError != nil }
    XCTAssertEqual(model.wizard.routeCheck, .problem)
    XCTAssertEqual(model.wizard.routeError, "Enable HTTPS")
    XCTAssertEqual(harness.refreshes, 1)
    model.send(.retry)
    await waitUntil { harness.routeReply != nil }
    XCTAssertEqual(model.wizard.routeCheck, .working)
    harness.routeReply?.resume(returning: nil)
    harness.routeReply = nil
    await waitUntil { !model.wizard.settingUpRoute }
    XCTAssertNil(model.wizard.routeError)
    XCTAssertEqual(harness.refreshes, 2)
    model.stop()
  }

  @MainActor func testPollingRefreshesTheServerAndDetectsANewPhoneWithoutUserAction() async throws {
    let harness = Harness()
    let model = harness.make()
    harness.enterPair(model)
    harness.snapshot.server = .running(tailscale: true, route: "routed", servesOtherHome: false)
    await waitUntil { harness.requests.count == 1 }
    harness.requests[0].1.resume(returning: try harness.code("waiting"))
    await waitUntil { model.code != nil }
    await model.start()
    defer { model.stop() }
    await waitUntil { harness.reloads == 1 }
    XCTAssertEqual(harness.refreshes, 1)
    XCTAssertEqual(harness.tailscaleReads, 0)
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .secondsSince1970
    harness.devices = [
      try decoder.decode(
        PairedDevice.self,
        from: Data(
          """
          {"id":"new-phone","name":"Janic's iPhone","identity":{"kind":"tailnet"},
           "pairedAt":\(harness.now.timeIntervalSince1970),"capabilities":["read","control"]}
          """.utf8))
    ]
    harness.now = harness.now.addingTimeInterval(2)
    await waitUntil { model.wizard.step == .done }
    XCTAssertEqual(model.wizard.paired?.name, "Janic's iPhone")
    XCTAssertEqual(harness.reloads, 2)
    XCTAssertEqual(harness.refreshes, 2)
  }
}
