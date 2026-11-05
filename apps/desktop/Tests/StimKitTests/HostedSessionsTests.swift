import Foundation
import Testing

@testable import StimKit

struct HostedSessionsTests {
  private func payload() throws -> HostedSessionsPayload {
    let url = try #require(Bundle.module.url(forResource: "hosted-sessions", withExtension: "json", subdirectory: "Fixtures"))
    return try JSONDecoder().decode(HostedSessionsPayload.self, from: Data(contentsOf: url))
  }

  @Test func preservesSessionsWithExtraFieldsAndFutureStates() throws {
    let rows = try payload().sessions
    #expect(rows.map(\.id) == ["ios-session", "android-session", "macos-session"])
    #expect(rows.map(\.state) == [.ready, .unknown, .stopped])
    #expect(rows.map(\.platform) == [.ios, .android, .macos])
    #expect(rows[0].client.name == "Laptop")
    #expect(rows[0].device == "iPhone 17")
    #expect(rows[1].app == nil)
    #expect(rows[2].device == nil)
    #expect(rows[2].app == "Example Desktop")
  }

  @Test func labelsParkedDevicesBeforeStoppedAndFutureStatesAsNeedingAttention() throws {
    let rows = try payload().sessions
    #expect(rows.map(\.stateLabel) == ["Running", "Needs attention", "Parked"])
    var row = rows[0]
    row.state = .preparing
    #expect(row.stateLabel == "Preparing")
    row.state = .stopping
    #expect(row.stateLabel == "Stopping")
    row.state = .stopped
    #expect(row.stateLabel == "Stopped")
    row.parked = true
    #expect(row.stateLabel == "Parked")
  }

  @Test func showsShortAgeForISO8601WithOrWithoutFractionalSeconds() throws {
    let rows = try payload().sessions
    let now = try #require(parseTimestamp("2026-10-07T12:05:00Z"))
    #expect(rows[0].sinceText(now: now) == "5m ago")
    #expect(rows[1].sinceText(now: now) == "1h05m ago")
  }
}
