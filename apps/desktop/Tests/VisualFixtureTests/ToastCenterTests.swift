import XCTest

@testable import StimDesktop

@MainActor final class ToastCenterTests: XCTestCase {
  private let lifetime = 0.1

  private func wait(_ seconds: Double) async throws {
    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
  }

  private func show(_ center: ToastCenter) -> Toast.ID {
    let toast = Toast(icon: "bell", title: "Build finished")
    center.show(toast)
    return toast.id
  }

  func testToastLeavesAfterItsLifetime() async throws {
    let center = ToastCenter(lifetime: lifetime, voiceOver: false)
    _ = show(center)
    try await wait(lifetime * 4)
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
    try await wait(lifetime * 4)
    XCTAssertTrue(center.toasts.isEmpty)
  }

  func testReleaseRestartsTheCountdown() async throws {
    let center = ToastCenter(lifetime: lifetime, voiceOver: false)
    let id = show(center)
    center.hold(id, .pointer, true)
    center.release(id)
    try await wait(lifetime * 4)
    XCTAssertTrue(center.toasts.isEmpty)
  }

  func testToastShownBeforeVoiceOverTurnsOnStopsExpiring() async throws {
    let center = ToastCenter(lifetime: lifetime, voiceOver: false)
    _ = show(center)
    center.voiceOverChanged(true)
    try await wait(lifetime * 4)
    XCTAssertEqual(center.toasts.count, 1)

    center.voiceOverChanged(false)
    try await wait(lifetime * 4)
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
}
