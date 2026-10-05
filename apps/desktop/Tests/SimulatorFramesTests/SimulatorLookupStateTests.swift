import Foundation
import Testing

@testable import SimulatorFrames

@Suite struct SimulatorLookupStateTests {
  @Test func duplicateRequestsCannotStartAnotherLookupForTheSameDevice() {
    var state = SimulatorLookupState()
    let first = UUID()
    let admissions = [
      state.begin(udid: "booting", id: first),
      state.begin(udid: "booting", id: UUID()),
      state.begin(udid: "ready", id: UUID()),
    ]
    #expect(admissions == [true, false, true])
    #expect(state.phase(udid: "booting") == .connecting)
    let delivered = state.finish(udid: "booting", id: first)
    #expect(delivered)
    #expect(state.phase(udid: "ready") == .connecting)
  }

  @Test func timeoutReportsFailureWithoutReleasingABlockedLookup() {
    var state = SimulatorLookupState()
    let id = UUID()
    let started = state.begin(udid: "booting", id: id)
    let timedOut = state.timeout(udid: "booting", id: id)
    #expect(started && timedOut)
    #expect(state.phase(udid: "booting") == .failed)
    let duplicateTimeout = state.timeout(udid: "booting", id: id)
    let anotherAttempt = state.begin(udid: "booting", id: UUID())
    #expect(!duplicateTimeout && !anotherAttempt)
  }

  @Test func lateResultIsDroppedAndOnlyItsReturnAllowsReconnection() {
    var state = SimulatorLookupState()
    let first = UUID()
    let trace = [
      state.begin(udid: "booting", id: first),
      state.timeout(udid: "booting", id: first),
      state.finish(udid: "booting", id: first),
    ]
    #expect(trace == [true, true, false])
    #expect(state.phase(udid: "booting") == .idle)
    let reconnect = UUID()
    let started = state.begin(udid: "booting", id: reconnect)
    let delivered = state.finish(udid: "booting", id: reconnect)
    #expect(started && delivered)
  }

  @Test func completedAttemptCannotTimeOutOrReleaseItsReplacement() {
    var state = SimulatorLookupState()
    let first = UUID()
    let started = state.begin(udid: "device", id: first)
    let delivered = state.finish(udid: "device", id: first)
    #expect(started && delivered)
    let reconnect = UUID()
    let trace = [
      state.begin(udid: "device", id: reconnect),
      state.timeout(udid: "device", id: first),
      state.finish(udid: "device", id: first),
      state.begin(udid: "device", id: UUID()),
      state.finish(udid: "device", id: reconnect),
    ]
    #expect(trace == [true, false, false, false, true])
  }
}
