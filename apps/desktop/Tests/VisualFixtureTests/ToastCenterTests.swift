import Combine
import StimKit
import XCTest

@testable import StimDesktop

@MainActor final class ToastCenterTests: XCTestCase {
  private let lifetime = 0.1

  private func wait(_ seconds: Double) async throws {
    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
  }

  private func waitUntilEmpty(_ center: ToastCenter) async throws {
    let deadline = Date().addingTimeInterval(5)
    while !center.toasts.isEmpty && Date() < deadline { try await wait(0.02) }
  }

  private func show(_ center: ToastCenter) -> Toast.ID {
    let toast = Toast(icon: "bell", title: "Build finished")
    center.show(toast)
    return toast.id
  }

  func testToastLeavesAfterItsLifetime() async throws {
    let center = ToastCenter(lifetime: lifetime, voiceOver: false)
    _ = show(center)
    try await waitUntilEmpty(center)
    XCTAssertTrue(center.toasts.isEmpty)
  }

  func testHeldToastStaysUntilReleased() async throws {
    let center = ToastCenter(lifetime: lifetime, voiceOver: false)
    let id = show(center)
    center.hold(id, .pointer, true)
    center.hold(id, .focus, true)
    try await wait(lifetime * 4)
    XCTAssertEqual(center.toasts.count, 1)

    center.hold(id, .pointer, false)
    try await wait(lifetime * 4)
    XCTAssertEqual(center.toasts.count, 1, "the focus hold is still on")

    center.hold(id, .focus, false)
    try await waitUntilEmpty(center)
    XCTAssertTrue(center.toasts.isEmpty)
  }

  func testReleaseRestartsTheCountdown() async throws {
    let center = ToastCenter(lifetime: lifetime, voiceOver: false)
    let id = show(center)
    center.hold(id, .pointer, true)
    center.release(id)
    try await waitUntilEmpty(center)
    XCTAssertTrue(center.toasts.isEmpty)
  }

  func testToastShownBeforeVoiceOverTurnsOnStopsExpiring() async throws {
    let center = ToastCenter(lifetime: lifetime, voiceOver: false)
    _ = show(center)
    center.voiceOverChanged(true)
    try await wait(lifetime * 4)
    XCTAssertEqual(center.toasts.count, 1)

    center.voiceOverChanged(false)
    try await waitUntilEmpty(center)
    XCTAssertTrue(center.toasts.isEmpty)
  }

  func testVoiceOverOffDoesNotRestartAHeldToast() async throws {
    let center = ToastCenter(lifetime: lifetime, voiceOver: true)
    let id = show(center)
    center.hold(id, .pointer, true)
    center.voiceOverChanged(false)
    try await wait(lifetime * 4)
    XCTAssertEqual(center.toasts.count, 1)
  }

  func testRemovedWorkspaceToastsLeaveWhileStoppedAndUnscopedToastsStay() throws {
    let payload = try JSONDecoder().decode(
      StatusPayload.self,
      from: Data(
        #"{"environments":[{"path":"/stopped","live":false,"warnings":[]}]}"#.utf8))
    let center = ToastCenter(voiceOver: false)
    let stopped = Toast(icon: "bell", title: "Stopped workspace", sticky: true, workspacePath: "/stopped")
    let machine = Toast(icon: "bell", title: "Machine", sticky: true)
    let notFound = Toast(icon: "bell", title: "Workspace not found", sticky: true, key: "workspace-link:/missing")
    let removed = Toast(icon: "bell", title: "Removed workspace", sticky: true, workspacePath: "/removed")
    let otherRemoved = Toast(icon: "bell", title: "Other removed workspace", sticky: true, workspacePath: "/other-removed")
    for toast in [stopped, machine, notFound, removed, otherRemoved] { center.show(toast) }

    center.dismissCards(notIn: payload)

    XCTAssertEqual(center.toasts.map(\.id), [notFound.id, machine.id, stopped.id])
  }

  func testRemovedWorkspaceToastsCancelTheirTimersAndReleaseTheirHolds() async throws {
    let payload = try JSONDecoder().decode(StatusPayload.self, from: Data(#"{"environments":[]}"#.utf8))
    let center = ToastCenter(lifetime: lifetime, voiceOver: false)
    let timed = Toast(icon: "bell", title: "Timed", workspacePath: "/removed")
    let held = Toast(icon: "bell", title: "Held", workspacePath: "/removed")
    center.show(timed)
    center.show(held)
    center.hold(held.id, .pointer, true)
    center.hold(held.id, .focus, true)
    var emissions = 0
    let subscription = center.$toasts.sink { _ in emissions += 1 }

    center.dismissCards(notIn: payload)
    XCTAssertTrue(center.toasts.isEmpty)
    let emissionsAfterDismissal = emissions
    try await wait(lifetime * 4)
    XCTAssertEqual(emissions, emissionsAfterDismissal)

    center.show(held)
    try await waitUntilEmpty(center)
    XCTAssertTrue(center.toasts.isEmpty)
    subscription.cancel()
  }
}
