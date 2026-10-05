import AppKit
import Testing

@testable import SimulatorFrames

@Suite struct SimulatorKeyboardModifiersTests {
  @Test func shiftHeldBeforeOptionIsRestoredOnOptionRelease() {
    var modifiers = SimulatorKeyboardModifiers()
    let trace =
      modifiers.change(keyCode: 56, flags: .shift)
      + modifiers.change(keyCode: 58, flags: [.option, .shift])
      + modifiers.change(keyCode: 58, flags: .shift)
      + modifiers.change(keyCode: 56, flags: [])
    #expect(trace.map { $0.code } == [56, 56, 56, 56])
    #expect(trace.map { $0.down } == [true, false, true, false])
    #expect(modifiers.release().isEmpty)
  }

  @Test func rightShiftPressedDuringPanIsForwardedOnlyAfterOptionRelease() {
    var modifiers = SimulatorKeyboardModifiers()
    #expect(modifiers.change(keyCode: 58, flags: .option).isEmpty)
    #expect(modifiers.change(keyCode: 60, flags: [.option, .shift]).isEmpty)
    let restored = modifiers.change(keyCode: 58, flags: .shift)
    #expect(restored.map { $0.code } == [60])
    #expect(restored.map { $0.down } == [true])
    #expect(modifiers.release() == [60])
    #expect(modifiers.release().isEmpty)
  }

  @Test func shiftReleaseDuringOptionDoesNotLeakAKeyToTheGuest() {
    var modifiers = SimulatorKeyboardModifiers()
    #expect(modifiers.change(keyCode: 58, flags: .option).isEmpty)
    #expect(modifiers.change(keyCode: 56, flags: [.option, .shift]).isEmpty)
    #expect(modifiers.change(keyCode: 56, flags: .option).isEmpty)
    #expect(modifiers.change(keyCode: 58, flags: []).isEmpty)
    #expect(modifiers.release().isEmpty)
  }
}
