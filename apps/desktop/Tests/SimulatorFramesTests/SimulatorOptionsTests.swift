import Foundation
import Testing

@testable import SimulatorFrames

@Suite struct SimulatorOptionsTests {
  let udid = "11111111-2222-3333-4444-555555555555"

  @Test func readsTheNativeAppearanceEnvelope() throws {
    let data = Data(
      #"{"info":{"outcome":"success","jsonVersion":5},"result":{"deviceIdentifier":"11111111-2222-3333-4444-555555555555","userInterfaceStyle":"light","textSize":"Large","increaseContrast":false,"largerAccessibilitySizesEnabled":false,"reduceMotion":{"enabled":false},"reduceTransparency":{"enabled":true},"showBorders":{"enabled":false},"liquidGlassOpacity":0.5}}"#
        .utf8)
    let appearance = try SimulatorOptions.parse(data, udid: udid)
    #expect(appearance.mode == .light)
    #expect(appearance.size == .large)
    #expect(appearance.increaseContrast == false)
    #expect(appearance.reduceMotion?.enabled == false)
    #expect(appearance.reduceTransparency?.enabled == true)
    #expect(appearance.largerAccessibilitySizesEnabled == false)
  }

  @Test func doesNotInventValuesForUnsupportedOptions() throws {
    let data = Data(
      #"{"info":{"outcome":"success"},"result":{"deviceIdentifier":"11111111-2222-3333-4444-555555555555","userInterfaceStyle":"unsupported","textSize":"unknown"}}"#
        .utf8)
    let appearance = try SimulatorOptions.parse(data, udid: udid)
    #expect(appearance.mode == nil)
    #expect(appearance.size == nil)
    #expect(appearance.increaseContrast == nil)
    #expect(appearance.reduceMotion?.enabled == nil)
    #expect(appearance.reduceTransparency?.enabled == nil)
    #expect(appearance.showBorders?.enabled == nil)
  }

  @Test func refusesAnotherDeviceAndUnsuccessfulReads() {
    let another = Data(
      #"{"info":{"outcome":"success"},"result":{"deviceIdentifier":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE","userInterfaceStyle":"dark"}}"#
        .utf8)
    let failed = Data(#"{"info":{"outcome":"failure"},"result":null}"#.utf8)
    #expect(throws: (any Error).self) { try SimulatorOptions.parse(another, udid: udid) }
    #expect(throws: (any Error).self) { try SimulatorOptions.parse(failed, udid: udid) }
  }

  @Test func recognizesNativeTextSizeLabels() throws {
    let data = Data(
      #"{"info":{"outcome":"success"},"result":{"deviceIdentifier":"11111111-2222-3333-4444-555555555555","textSize":"Accessibility Extra Extra Large","largerAccessibilitySizesEnabled":true}}"#
        .utf8)
    let appearance = try SimulatorOptions.parse(data, udid: udid)
    #expect(appearance.size == .accessibilityExtraExtraLarge)
    #expect(appearance.size?.isAccessibilitySize == true)
  }
}

@Suite struct SimulatorOptionsPollingTests {
  @Test func readsOnOpenThenRepeatsAndStopsWhenCancelled() async throws {
    let counter = Counter()
    let task = Task { await SimulatorOptionsPolling.run(interval: .milliseconds(20)) { await counter.increment() } }
    try await Task.sleep(for: .milliseconds(10))
    #expect(await counter.value == 1)
    try await Task.sleep(for: .milliseconds(150))
    #expect(await counter.value >= 3)
    task.cancel()
    await task.value
    let stopped = await counter.value
    try await Task.sleep(for: .milliseconds(80))
    #expect(await counter.value == stopped)
  }

  @Test func dropsAReadThatStartedBeforeAChange() {
    var polling = SimulatorOptionsPolling()
    let token = polling.token
    polling.beginChange()
    polling.endChange()
    #expect(!polling.accepts(token))
    #expect(polling.accepts(polling.token))
  }

  @Test func refusesReadsWhileAChangeIsInFlight() {
    var polling = SimulatorOptionsPolling()
    polling.beginChange()
    #expect(!polling.canStartRead)
    #expect(!polling.accepts(polling.token))
    polling.endChange()
    #expect(polling.canStartRead)
  }
}

private actor Counter {
  private(set) var value = 0
  func increment() { value += 1 }
}
