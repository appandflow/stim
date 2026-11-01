import Foundation
import Testing

@testable import StimKit

@Suite struct CapacityMetersTests {
  private func payload(capacity: String) throws -> StatusPayload {
    let json =
      #"{"environments":[],"capacity":{"liveCount":0,"committedMb":0,"totalMemoryMb":1,"overCapacity":false,"# + capacity + "}}"
    return try JSONDecoder().decode(StatusPayload.self, from: Data(json.utf8))
  }

  private func fixture() throws -> StatusPayload {
    let url = try #require(Bundle.module.url(forResource: "Fixtures/status.json", withExtension: nil))
    return try JSONDecoder().decode(StatusPayload.self, from: Data(contentsOf: url))
  }

  @Test func aPayloadFromAnOlderStimHasNoLoadOrMeters() throws {
    let capacity = try #require(payload(capacity: #""x":1"#).capacity)
    #expect(capacity.load == nil && capacity.builds == nil && capacity.devices == nil)
    #expect(capacity.meters.isEmpty)
  }

  @Test func decodesAWholeNumberLoadAndAStateItDoesNotKnow() throws {
    let whole = try #require(
      payload(capacity: #""load":{"cpus":8,"loadPerCore":4,"busyAt":2,"limit":null,"state":"busy"}"#).capacity?.load)
    #expect(whole.loadPerCore == 4 && whole.text == "4/core" && whole.limit == nil && whole.tone == .caution)
    let fractional = try #require(
      payload(capacity: #""load":{"cpus":8,"loadPerCore":2.4,"busyAt":2,"limit":3,"state":"holding"}"#).capacity?.load)
    #expect(fractional.text == "2.4/core" && fractional.limit == 3 && fractional.tone == .error)
    let future = try #require(
      payload(capacity: #""load":{"cpus":8,"loadPerCore":0.5,"busyAt":2,"limit":null,"state":"drained"}"#).capacity?.load)
    #expect(future.state == .other && future.tone == .normal)
  }

  @Test func metersShowTheSlotsInUseAndAnUncountableTotalAsAQuestionMark() throws {
    let full = try fixture().capacity?.meters
    #expect(full?.map(\.value) == ["3 / 3", "2 / 2"] && full?.allSatisfy(\.isFull) == true)
    let capacity = try #require(
      payload(
        capacity:
          #""devices":{"max":4,"inUse":null,"unknown":"simctl did not answer","holders":[]},"builds":{"max":2,"inUse":1,"holders":[]}"#
      ).capacity)
    #expect(
      capacity.meters == [
        CapacityMeter(kind: .devices, label: "Devices", value: "? / 4", isFull: false, reason: "simctl did not answer"),
        CapacityMeter(kind: .builds, label: "Builds", value: "1 / 2", isFull: false, reason: nil),
      ])
  }

  @Test func aPlatformCapShowsItsOwnMeterWithOrWithoutTheSharedDeviceCap() throws {
    let capacity = try #require(
      payload(
        capacity:
          #""platformDevices":{"ios":{"max":2,"inUse":2},"android":{"max":3,"inUse":null,"unknown":"adb did not answer"}}"#
      ).capacity)
    #expect(capacity.devices == nil)
    #expect(
      capacity.meters == [
        CapacityMeter(kind: .ios, label: "iOS simulators", value: "2 / 2", isFull: true, reason: nil),
        CapacityMeter(kind: .android, label: "Android emulators", value: "? / 3", isFull: false, reason: "adb did not answer"),
      ])
    #expect(capacity.meters.map(\.kind.countsDevices) == [true, true])
  }

  @Test func deviceHoldersCarryIdleTimeAndAStopOnlyWhenAWorkspaceRecordsThem() throws {
    let status = try fixture()
    let devices = try #require(status.capacity?.devices)
    let now = try #require(parseTimestamp("2026-09-25T01:00:00.000Z"))
    let rows = devices.rows(in: status.environments, now: now)
    let workspace = "/Users/dev/app/.worktrees/wide-insets/apps/mobile"
    #expect(rows.map(\.detail) == ["Idle 2h", "Booting", nil])
    #expect(rows[0].stop == StimCommand(["stop", "--slot", "default"], cwd: workspace))
    #expect(rows[1].stop == StimCommand(["stop", "--slot", "ipad"], cwd: workspace))
    #expect(rows[2].stop == nil && rows[2].label == "stim-old (iPhone 17 27.0)")
  }

  @Test func buildHoldersAreAWorkspaceAClientOrUnresolved() throws {
    let holders = try #require(fixture().capacity?.builds?.holders)
    #expect(holders.map(\.owner) == [.workspace("/Users/dev/app/.worktrees/wide-insets/apps/mobile"), .client("dev-macbook")])
    let unresolved = BuildSlotHolder(slot: 2, workspace: nil, client: nil, since: nil, unresolved: true)
    #expect(unresolved.owner == .unresolved)
  }
}
