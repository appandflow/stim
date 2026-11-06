import Foundation
import Testing

@testable import StimKit

struct WebShareTests {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
  }

  private let row = """
    {"id":"w1","workspace":"/Users/me/app","platform":"ios","slot":"default","physical":false,"control":true,
     "expiresAt":"2026-11-02T13:00:00.000Z","viewers":2,"auth":"generated"}
    """

  @Test func decodesTheListAndTheStartedShareWithItsGeneratedPassword() throws {
    let list = try decode(WebSharesPayload.self, "{\"shares\":[\(row)]}")
    #expect(list.shares.map(\.id) == ["w1"])
    #expect(list.shares[0].auth == .generated)
    let withPassword = try decode(
      StartedWebShare.self,
      String(row.dropLast()) + ",\"url\":\"https://mac.ts.net:10000/s/abc/\",\"password\":\"k7mfx2rbq9tnh4ze\"}")
    #expect(withPassword.share.id == "w1")
    #expect(withPassword.url == "https://mac.ts.net:10000/s/abc/")
    #expect(withPassword.password == "k7mfx2rbq9tnh4ze")
    let chosen = try decode(
      StartedWebShare.self,
      String(row.dropLast()).replacingOccurrences(of: "generated", with: "set") + ",\"url\":\"https://mac.ts.net/s/abc/\"}")
    #expect(chosen.share.auth == .set)
    #expect(chosen.password == nil)
  }

  @Test func readsTheViewPasswordRowsAndLabelsTheAccess() throws {
    let plain = try decode(WebShare.self, row)
    #expect(plain.viewAuth == nil)
    #expect(plain.accessLabel == "View and control")
    let started = try decode(
      StartedWebShare.self,
      String(row.dropLast())
        + ",\"viewAuth\":\"generated\",\"url\":\"https://mac.ts.net/s/abc/\",\"viewPassword\":\"p2xqd8hs5nw3cvje\"}")
    #expect(started.share.viewAuth == .generated)
    #expect(started.share.accessLabel == "View and control, view password")
    #expect(started.viewPassword == "p2xqd8hs5nw3cvje")
  }

  @Test func sendsAViewPasswordOnlyForAControlShareWithAPassword() {
    var options = WebShareOptions()
    options.viewPassword = .generated
    #expect(options.params(workspace: "/w", platform: "ios", slot: "default")["view"] == nil)
    options.control = true
    #expect(options.params(workspace: "/w", platform: "ios", slot: "default")["view"] == .object([:]))
    options.viewPassword = .custom("watch only!")
    #expect(
      options.params(workspace: "/w", platform: "ios", slot: "default")["view"] == .object(["password": .string("watch only!")]))
    options.password = .none
    #expect(options.params(workspace: "/w", platform: "ios", slot: "default")["view"] == nil)
    options.password = .custom("watch only!")
    #expect(options.problem == "The view password and the control password must differ.")
    options.viewPassword = .custom("short")
    #expect(options.problem != nil)
  }

  @Test func countsTimeLeftFromTheExpiryAndMarksAPassedOneExpired() throws {
    let share = try decode(WebShare.self, row)
    let now = try #require(parseTimestamp("2026-11-02T12:18:00Z"))
    #expect(share.timeLeft(now: now) == "42m left")
    #expect(share.timeLeft(now: try #require(parseTimestamp("2026-11-02T13:00:30Z"))) == "Expired")
  }

  @Test func sendsOnlyTheParametersTheCLISends() {
    var options = WebShareOptions()
    #expect(
      options.params(workspace: "/w", platform: "ios", slot: "default") == [
        "workspace": .string("/w"), "platform": .string("ios"), "control": .bool(false), "expiresMinutes": .number(60),
      ])
    options.control = true
    options.minutes = 15
    options.password = .custom("correct horse")
    let custom = options.params(workspace: "/w", platform: "android", slot: "two")
    #expect(custom["slot"] == .string("two"))
    #expect(custom["password"] == .string("correct horse"))
    #expect(custom["passwordless"] == nil)
    options.password = .none
    let open = options.params(workspace: "/w", platform: "android", slot: "default")
    #expect(open["passwordless"] == .bool(true))
    #expect(open["password"] == nil)
  }

  @Test func refusesTheMinutesAndPasswordLengthsTheServerRefuses() {
    var options = WebShareOptions()
    #expect(options.problem == nil)
    options.minutes = 481
    #expect(options.problem != nil)
    options.minutes = 0
    #expect(options.problem != nil)
    options.minutes = 60
    options.password = .custom("short")
    #expect(options.problem != nil)
    options.password = .custom(String(repeating: "a", count: 129))
    #expect(options.problem != nil)
    options.password = .custom(String(repeating: "a", count: 8))
    #expect(options.problem == nil)
  }
}
