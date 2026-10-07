import Foundation
import StimKit
import XCTest

@testable import StimDesktop

final class HostedSessionsModelTests: XCTestCase {
  private func list(state: String = "ready", parked: Bool = false) throws -> JSONValue {
    try JSONDecoder().decode(
      JSONValue.self,
      from: Data(
        """
        {"sessions":[{"id":"session-a","client":{"id":"client-a","name":"Laptop"},"platform":"ios",
          "device":"iPhone 17","app":"Example","state":"\(state)","parked":\(parked),
          "since":"2026-10-07T12:00:00Z","workspace":"workspace-a"}]}
        """.utf8))
  }

  @MainActor func testListFailuresHidePreviouslyVisibleSessionsWithoutAToast() async throws {
    for code in ["forbidden", "bad-request", "unknown-method", "not-connected"] {
      let toasts = ToastCenter(voiceOver: false)
      var failure: String?
      let model = HostedSessionsModel(toasts: toasts) { method, params in
        XCTAssertEqual(method, "device-host.sessions")
        XCTAssertTrue(params.isEmpty)
        if let failure { throw ServerError(code: failure, message: "Unavailable") }
        return try self.list()
      }
      await model.refresh()
      XCTAssertEqual(model.sessions?.first?.id, "session-a")
      failure = code
      await model.refresh()
      XCTAssertNil(model.sessions)
      XCTAssertTrue(toasts.toasts.isEmpty)
    }
  }

  @MainActor func testStopSendsTheSessionIdAndRefreshesWhileKeepingTheRowBusy() async throws {
    let toasts = ToastCenter(voiceOver: false)
    var calls: [String] = []
    var stopped = false
    var waiting: CheckedContinuation<Void, Never>?
    let model = HostedSessionsModel(toasts: toasts) { method, params in
      calls.append(method)
      if method == "device-host.sessions.stop" {
        XCTAssertEqual(params, ["session": .string("session-a")])
        await withCheckedContinuation { waiting = $0 }
        stopped = true
        return .object(["id": .string("session-a"), "state": .string("stopped")])
      }
      XCTAssertTrue(params.isEmpty)
      return stopped ? .object(["sessions": .array([])]) : try self.list()
    }
    await model.refresh()
    let session = try XCTUnwrap(model.sessions?.first)
    let stop = Task { await model.stop(session) }
    await waitUntil { waiting != nil }
    XCTAssertEqual(model.stopping, ["session-a"])
    await model.stop(session)
    XCTAssertEqual(calls, ["device-host.sessions", "device-host.sessions.stop"])
    waiting?.resume()
    await stop.value
    XCTAssertEqual(calls, ["device-host.sessions", "device-host.sessions.stop", "device-host.sessions"])
    XCTAssertEqual(model.sessions, [])
    XCTAssertTrue(model.stopping.isEmpty)
    XCTAssertTrue(toasts.toasts.isEmpty)
  }

  @MainActor func testStopFailureShowsAToastAndLeavesTheSessionAvailableToRetry() async throws {
    let toasts = ToastCenter(voiceOver: false)
    let model = HostedSessionsModel(toasts: toasts) { method, _ in
      if method == "device-host.sessions.stop" { throw ServerError(code: "busy", message: "Native work is running") }
      return try self.list()
    }
    await model.refresh()
    await model.stop(try XCTUnwrap(model.sessions?.first))
    XCTAssertEqual(toasts.toasts.first?.body, "Native work is running")
    XCTAssertEqual(model.sessions?.first?.state, .ready)
    XCTAssertTrue(model.stopping.isEmpty)
  }

  @MainActor func testAnOlderPollCannotRestoreASessionAfterTheStopRefresh() async throws {
    var reads = 0
    var waiting: CheckedContinuation<Void, Never>?
    let model = HostedSessionsModel(toasts: ToastCenter(voiceOver: false)) { method, _ in
      if method == "device-host.sessions.stop" {
        return .object(["id": .string("session-a"), "state": .string("stopped")])
      }
      reads += 1
      if reads == 2 {
        await withCheckedContinuation { waiting = $0 }
        return try self.list()
      }
      return reads > 2 ? .object(["sessions": .array([])]) : try self.list()
    }
    await model.refresh()
    let session = try XCTUnwrap(model.sessions?.first)
    let poll = Task { await model.refresh() }
    await waitUntil { waiting != nil }
    await model.stop(session)
    XCTAssertEqual(model.sessions, [])
    waiting?.resume()
    await poll.value
    XCTAssertEqual(model.sessions, [])
  }

  @MainActor func testStoppedParkedAndStoppingSessionsDoNotSendAnotherStop() async throws {
    for (state, parked) in [("stopped", false), ("stopped", true), ("stopping", false)] {
      var calls: [String] = []
      let model = HostedSessionsModel(toasts: ToastCenter(voiceOver: false)) { method, _ in
        calls.append(method)
        return try self.list(state: state, parked: parked)
      }
      await model.refresh()
      await model.stop(try XCTUnwrap(model.sessions?.first))
      XCTAssertEqual(calls, ["device-host.sessions"])
      XCTAssertTrue(model.stopping.isEmpty)
    }
  }
}
