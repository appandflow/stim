import Testing

@testable import SimulatorFrames

@Suite struct SimulatorTypingTests {
  @Test func typesPrintableAsciiReturnAndTabWithShiftForUppercaseAndSymbols() throws {
    let keys = try #require(SimulatorTyping.keys(for: "aB1!\n\t"))
    #expect(keys.map(\.code) == [0x00, 0x0B, 0x12, 0x12, 0x24, 0x30])
    #expect(keys.map(\.shift) == [false, true, false, true, false, false])
  }

  @Test func typesCrlfAsOneReturn() throws {
    let keys = try #require(SimulatorTyping.keys(for: "a\r\nb"))
    #expect(keys.map(\.code) == [0x00, 0x24, 0x0B])
  }

  @Test func typesAtMostTheClipboardLimit() {
    #expect(SimulatorTyping.keys(for: String(repeating: "a", count: 8192))?.count == 8192)
    #expect(SimulatorTyping.keys(for: String(repeating: "a", count: 8193)) == nil)
  }

  @Test func leavesWhatTheHidKeyboardCannotTypeToCommandV() {
    for text in ["", "h\u{e9}llo", "smile \u{1F600}", "bell\u{7}", "back\u{8}space", "lone\rreturn"] {
      #expect(SimulatorTyping.keys(for: text) == nil, "\(text.debugDescription)")
    }
  }
}
