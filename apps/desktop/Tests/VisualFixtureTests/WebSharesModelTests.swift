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

  @MainActor func testAnOldServerLeavesNoShareListAndAnAnswerlessOneIsNoShares() async throws {
    let old = WebSharesModel(toasts: ToastCenter(voiceOver: false)) { _, _ in
      throw ServerError(code: "unknown-method", message: "No")
    }
    await old.refresh()
    XCTAssertNil(old.shares)
    let silent = WebSharesModel(toasts: ToastCenter(voiceOver: false)) { _, _ in
      try await Task.sleep(for: .seconds(30))
      return .null
    }
    let live = await silent.liveShares(within: .milliseconds(50))
    XCTAssertTrue(live.isEmpty)
  }
}
