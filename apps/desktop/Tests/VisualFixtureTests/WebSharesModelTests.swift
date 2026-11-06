import Foundation
import StimKit
import XCTest

@testable import StimDesktop

final class WebSharesModelTests: XCTestCase {
  private let row = """
    {"id":"w1","workspace":"/w","platform":"ios","slot":"default","physical":false,"control":false,
     "expiresAt":"2030-01-01T00:00:00.000Z","viewers":0,"auth":"generated"}
    """

  private func json(_ text: String) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
  }

  @MainActor func testStartSendsTheOptionsAndStopSendsTheWorkspaceThenBothRefresh() async throws {
    var live = false
    var calls: [(String, [String: JSONValue])] = []
    let model = WebSharesModel(toasts: ToastCenter(voiceOver: false)) { method, params in
      calls.append((method, params))
      switch method {
      case "share.start":
        live = true
        return try self.json(String(self.row.dropLast()) + ",\"url\":\"https://x/s/t/\",\"password\":\"pw123456\"}")
      case "share.stop":
        live = false
        return try self.json("{\"stopped\":[]}")
      default:
        return try self.json("{\"shares\":[\(live ? self.row : "")]}")
      }
    }
    var options = WebShareOptions()
    options.minutes = 30
    let started = try await model.start(workspace: "/w", platform: "ios", slot: "default", options: options)
    XCTAssertEqual(started.password, "pw123456")
    XCTAssertEqual(calls.first?.0, "share.start")
    XCTAssertEqual(calls.first?.1["expiresMinutes"], .number(30))
    XCTAssertEqual(model.shares?.map(\.id), ["w1"])
    await model.stop(workspace: "/w")
    XCTAssertEqual(calls.first(where: { $0.0 == "share.stop" })?.1, ["workspace": .string("/w")])
    XCTAssertEqual(model.shares?.count, 0)
  }

  @MainActor func testStopSendsTheShareIdOnlyToAServerThatTakesItAndTheWorkspaceToAnOlderOne() async throws {
    var calls: [[String: JSONValue]] = []
    func model(takesId: Bool) -> WebSharesModel {
      WebSharesModel(
        toasts: ToastCenter(voiceOver: false),
        request: { method, params in
          if method == "share.stop" { calls.append(params) }
          return try self.json(method == "share.stop" ? "{\"stopped\":[]}" : "{\"shares\":[\(self.row)]}")
        },
        serverStopsOneShare: { takesId })
    }
    let share = try JSONDecoder().decode(WebShare.self, from: Data(row.utf8))
    let current = model(takesId: true)
    await current.refresh()
    XCTAssertTrue(current.stopsOneShare)
    await current.stop(share: share)
    let older = model(takesId: false)
    await older.refresh()
    XCTAssertFalse(older.stopsOneShare)
    await older.stop(share: share)
    XCTAssertEqual(calls, [["workspace": .string("/w"), "id": .string("w1")], ["workspace": .string("/w")]])
  }

  @MainActor func testAnOldServerLeavesNoShareList() async throws {
    let old = WebSharesModel(toasts: ToastCenter(voiceOver: false)) { _, _ in
      throw ServerError(code: "unknown-method", message: "No")
    }
    await old.refresh()
    XCTAssertNil(old.shares)
  }
}
