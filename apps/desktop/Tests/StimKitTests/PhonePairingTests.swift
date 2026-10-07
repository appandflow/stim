import XCTest

@testable import StimKit

final class PhonePairingTests: XCTestCase {
  private let now = Date(timeIntervalSince1970: 1_791_284_400)
  private let routed = PhoneServer.running(tailscale: true, route: "routed", servesOtherHome: false)

  private func phone(_ id: String, pairedAt: Date, capabilities: [String] = ["read"]) -> PairedDevice {
    PairedDevice(
      id: id, name: "iPhone \(id)", identity: .init(kind: "tailnet", nodeName: "phone", nodeId: "n\(id)", user: nil),
      pairedAt: pairedAt, lastSeenAt: nil, capabilities: capabilities, requestedCapability: nil, pendingUntil: nil)
  }

  private func wizard(
    serving: Bool = false, server: PhoneServer = .off, phones: [PairedDevice] = [], to step: PhonePairing.Step
  ) -> PhonePairing {
    var wizard = PhonePairing(servesPhones: serving, server: server, phones: phones, now: now)
    _ = wizard.apply(.tailscale(.running(dnsName: "mac.tail.test")), now: now)
    while wizard.step < step {
      if wizard.step == .serve { _ = wizard.apply(.server(routed), now: now) }
      _ = wizard.apply(.next, now: now)
    }
    return wizard
  }

  func testTailscaleReadsInstalledButQuitAsStoppedAndNotInstalledAsMissing() {
    let running = Data(#"{"BackendState":"Running","Self":{"DNSName":"Mac.Tail.Test."}}"#.utf8)
    XCTAssertEqual(MacTailscale(statusJSON: running, hasApp: true, hasCLI: false), .running(dnsName: "mac.tail.test"))
    let stopped = Data(#"{"BackendState":"Stopped"}"#.utf8)
    XCTAssertEqual(MacTailscale(statusJSON: stopped, hasApp: false, hasCLI: true), .stopped(hasApp: false))
    XCTAssertEqual(MacTailscale(statusJSON: nil, hasApp: true, hasCLI: false), .stopped(hasApp: true))
    XCTAssertEqual(MacTailscale(statusJSON: nil, hasApp: false, hasCLI: false), .missing)
  }

  func testTailscaleOnThisMacBlocksTheTailscaleStep() {
    var wizard = PhonePairing(servesPhones: false, server: .off, phones: [], now: now)
    _ = wizard.apply(.next, now: now)
    XCTAssertEqual(wizard.step, .tailscale)
    for state in [MacTailscale.checking, .missing, .stopped(hasApp: true)] {
      _ = wizard.apply(.tailscale(state), now: now)
      XCTAssertFalse(wizard.canContinue)
      XCTAssertEqual(wizard.apply(.next, now: now), [])
      XCTAssertEqual(wizard.step, .tailscale)
    }
    _ = wizard.apply(.tailscale(.running(dnsName: nil)), now: now)
    XCTAssertTrue(wizard.canContinue)
  }

  func testEnteringServingStartsTheServerOnlyWhenNotAlreadyServing() {
    var off = wizard(to: .tailscale)
    XCTAssertEqual(off.apply(.next, now: now), [.startServing])
    XCTAssertEqual(off.apply(.server(.starting), now: now), [])

    var adopted = wizard(serving: true, server: routed, to: .tailscale)
    XCTAssertEqual(adopted.apply(.next, now: now), [])
    XCTAssertEqual(adopted.serverCheck, .ok)
    XCTAssertTrue(adopted.canContinue)
  }

  func testARoutedServerNeverSetsUpARoute() {
    var wizard = wizard(serving: true, server: routed, to: .tailscale)
    var effects = wizard.apply(.next, now: now)
    for _ in 0..<3 {
      effects += wizard.apply(.server(routed), now: now)
      effects += wizard.apply(.tick, now: now)
    }
    XCTAssertFalse(effects.contains(.setUpRoute))
    XCTAssertEqual(wizard.routeCheck, .ok)
  }

  func testAMissingRouteIsSetUpOncePerAttemptAndAFunnelNever() {
    let missing = PhoneServer.running(tailscale: true, route: "missing", servesOtherHome: false)
    var wizard = wizard(to: .tailscale)
    _ = wizard.apply(.next, now: now)
    XCTAssertEqual(wizard.apply(.server(missing), now: now), [.setUpRoute])
    XCTAssertEqual(wizard.routeCheck, .working)
    XCTAssertEqual(wizard.apply(.server(missing), now: now), [])
    XCTAssertEqual(wizard.apply(.routeFinished(error: "HTTPS is off"), now: now), [])
    XCTAssertEqual(wizard.apply(.server(missing), now: now), [])
    XCTAssertEqual(wizard.routeCheck, .problem)
    XCTAssertFalse(wizard.canContinue)
    XCTAssertEqual(wizard.apply(.retry, now: now), [.setUpRoute])

    var funneled = self.wizard(to: .tailscale)
    _ = funneled.apply(.next, now: now)
    let effects = funneled.apply(
      .server(.running(tailscale: true, route: "funneled", servesOtherHome: false)), now: now)
    XCTAssertEqual(effects, [])
    XCTAssertEqual(funneled.apply(.retry, now: now), [])
    XCTAssertEqual(funneled.routeCheck, .problem)
    XCTAssertFalse(funneled.canContinue)
  }

  func testASuccessfulSetupWaitsForTheServerToReportTheRouteBeforeShowingAProblem() {
    let missing = PhoneServer.running(tailscale: true, route: "missing", servesOtherHome: false)
    var wizard = wizard(to: .tailscale)
    _ = wizard.apply(.next, now: now)
    XCTAssertEqual(wizard.apply(.server(missing), now: now), [.setUpRoute])
    _ = wizard.apply(.routeFinished(error: nil), now: now)
    _ = wizard.apply(.server(missing), now: now.addingTimeInterval(2))
    XCTAssertEqual(wizard.routeCheck, .working)
    _ = wizard.apply(.server(missing), now: now.addingTimeInterval(PhonePairing.routeReportGrace + 1))
    XCTAssertEqual(wizard.routeCheck, .problem)
  }

  func testRouteIsNotSetUpOutsideTheServingStepOrOffTheTailnet() {
    let missing = PhoneServer.running(tailscale: true, route: "missing", servesOtherHome: false)
    var early = PhonePairing(servesPhones: true, server: missing, phones: [], now: now)
    XCTAssertEqual(early.apply(.server(missing), now: now), [])

    var offTailnet = wizard(to: .tailscale)
    _ = offTailnet.apply(.next, now: now)
    XCTAssertEqual(
      offTailnet.apply(.server(.running(tailscale: false, route: "missing", servesOtherHome: false)), now: now), [])
    XCTAssertEqual(offTailnet.tailnetCheck, .problem)
  }

  func testFailedServerBlocksAndRetryStartsItAgainWhileAnotherHomeOnlyWarns() {
    var wizard = wizard(to: .tailscale)
    _ = wizard.apply(.next, now: now)
    _ = wizard.apply(.server(.failed("did not answer")), now: now)
    XCTAssertEqual(wizard.serverCheck, .problem)
    XCTAssertFalse(wizard.canContinue)
    XCTAssertEqual(wizard.apply(.retry, now: now), [.startServing])

    _ = wizard.apply(.server(.running(tailscale: true, route: "routed", servesOtherHome: true)), now: now)
    XCTAssertTrue(wizard.servesOtherHome)
    XCTAssertTrue(wizard.canContinue)
  }

  func testPairingRequestsACodeOnEntryAndOnAccessChangeAndIgnoresAStaleAnswer() {
    var wizard = wizard(serving: true, server: routed, to: .serve)
    XCTAssertEqual(wizard.apply(.next, now: now), [.requestCode(control: true)])
    XCTAssertEqual(wizard.apply(.access(control: false), now: now), [.requestCode(control: false)])
    _ = wizard.apply(.codeIssued(expiresAt: now.addingTimeInterval(300), control: true), now: now)
    XCTAssertNil(wizard.codeExpiresAt)
    _ = wizard.apply(.codeIssued(expiresAt: now.addingTimeInterval(300), control: false), now: now)
    XCTAssertEqual(wizard.codeExpiresAt, now.addingTimeInterval(300))
  }

  func testAnExpiredCodeIsReplacedThreeTimesThenWaitsForTheButton() {
    var wizard = wizard(serving: true, server: routed, to: .pair)
    var clock = now
    var renewed = 0
    for _ in 0..<6 {
      _ = wizard.apply(.codeIssued(expiresAt: clock.addingTimeInterval(300), control: true), now: clock)
      clock = clock.addingTimeInterval(301)
      if wizard.apply(.tick, now: clock) == [.requestCode(control: true)] { renewed += 1 }
    }
    XCTAssertEqual(renewed, PhonePairing.automaticRenewals)
    XCTAssertTrue(wizard.codeExpired(now: clock))
    XCTAssertEqual(wizard.apply(.newCode, now: clock), [.requestCode(control: true)])
    XCTAssertFalse(wizard.codeExpired(now: clock))
    _ = wizard.apply(.codeFailed("server stopped"), now: clock)
    XCTAssertEqual(wizard.apply(.tick, now: clock.addingTimeInterval(1)), [])
  }

  func testOnlyAPhonePairedAfterOpeningFinishes() {
    let existing = phone("old", pairedAt: now.addingTimeInterval(-3600))
    var wizard = wizard(serving: true, server: routed, phones: [existing], to: .pair)
    var macClient = phone("mac", pairedAt: now.addingTimeInterval(10))
    macClient.requestedCapability = "build"
    _ = wizard.apply(.devices([existing, macClient]), now: now)
    XCTAssertEqual(wizard.step, .pair)
    let earlier = phone("earlier", pairedAt: now.addingTimeInterval(-5))
    _ = wizard.apply(.devices([existing, earlier]), now: now)
    XCTAssertEqual(wizard.step, .pair)

    let new = phone("new", pairedAt: now.addingTimeInterval(20), capabilities: ["read", "control"])
    _ = wizard.apply(.devices([new, existing]), now: now)
    XCTAssertEqual(wizard.step, .done)
    XCTAssertEqual(wizard.paired?.id, "new")
    XCTAssertFalse(wizard.canGoBack)
  }

  func testCancelStopsServingOnlyWhenTheWizardTurnedItOnAndNoPhonePaired() {
    var turnedOn = wizard(to: .tailscale)
    _ = turnedOn.apply(.next, now: now)
    XCTAssertEqual(turnedOn.apply(.cancel, now: now), [.stopServing])
    XCTAssertEqual(turnedOn.apply(.next, now: now), [])

    var alreadyOn = wizard(serving: true, server: routed, to: .serve)
    XCTAssertEqual(alreadyOn.apply(.cancel, now: now), [])

    var paired = wizard(to: .pair)
    _ = paired.apply(.devices([phone("new", pairedAt: now.addingTimeInterval(1))]), now: now)
    XCTAssertEqual(paired.apply(.cancel, now: now), [])
  }
}
