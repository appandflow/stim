import Foundation
import Testing

@testable import EmulatorFrames

@Suite struct ScrcpyControlTests {
  @Test func encodesAKeycodeAsScrcpysOwnSerializationTest() {
    var expected = Data([0, 1, 0, 0, 0, 0x42])
    expected += Data(repeating: 0, count: 8)
    #expect(Scrcpy.keycode(.up, 66) == expected)
  }

  @Test func encodesTextAsScrcpysOwnSerializationTest() {
    #expect(Scrcpy.text("hello, world!") == Data([1, 0, 0, 0, 0x0d]) + Data("hello, world!".utf8))
  }

  @Test func encodesATouchWithScrcpysLayout() {
    let down = Scrcpy.touch(.down, pointer: 0x1234_5678_8765_4321, x: 100, y: 200, width: 1080, height: 1920)
    #expect(
      down
        == Data([
          2, 0, 0x12, 0x34, 0x56, 0x78, 0x87, 0x65, 0x43, 0x21, 0, 0, 0, 0x64, 0, 0, 0, 0xc8, 0x04, 0x38, 0x07, 0x80,
          0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0,
        ]))
    let up = Scrcpy.touch(.up, x: 1, y: 2, width: 3, height: 4)
    #expect(up.count == 32)
    #expect(up[1] == 1)
    #expect(Array(up[2..<10]) == [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe])
    #expect(Array(up[22..<24]) == [0, 0])
  }
}

@Suite struct ScrcpyClipboardTests {
  @Test func encodesSetClipboardWithScrcpysLayout() {
    #expect(
      Scrcpy.setClipboard("h\u{e9}", sequence: 0x0102_0304_0506_0708, paste: true)
        == Data([9, 1, 2, 3, 4, 5, 6, 7, 8, 1, 0, 0, 0, 3, 0x68, 0xc3, 0xa9]))
    #expect(Scrcpy.setClipboard("", sequence: 1, paste: false) == Data([9, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]))
    #expect(Scrcpy.getClipboard == Data([8, 0]))
  }

  @Test func splitsTheControlSocketIntoDeviceMessagesWhateverTheReadBoundaries() throws {
    let stream = Data([0, 0, 0, 0, 3, 0x61, 0xc3, 0xa9]) + Data([1, 0, 0, 0, 0, 0, 0, 0, 9]) + Data([0, 0, 0, 0, 0])
    var whole = ScrcpyDeviceMessageDemuxer()
    #expect(try whole.push(stream) == [.clipboard("a\u{e9}"), .clipboardAck(sequence: 9), .clipboard("")])
    var split = ScrcpyDeviceMessageDemuxer()
    var messages: [ScrcpyDeviceMessage] = []
    for byte in stream { messages += try split.push(Data([byte])) }
    #expect(messages == [.clipboard("a\u{e9}"), .clipboardAck(sequence: 9), .clipboard("")])
  }

  @Test func refusesAMessageKindItDoesNotKnow() {
    var demuxer = ScrcpyDeviceMessageDemuxer()
    #expect(throws: ScrcpyError.self) { try demuxer.push(Data([2, 0, 1])) }
  }
}

@Suite struct ScrcpyVideoTests {
  private func packet(config: Bool, keyframe: Bool, _ payload: [UInt8]) -> Data {
    var header = Data([(config ? 0x40 : 0) | (keyframe ? 0x20 : 0), 0, 0, 0, 0, 0, 0, 7])
    withUnsafeBytes(of: UInt32(payload.count).bigEndian) { header.append(contentsOf: $0) }
    return header + Data(payload)
  }

  @Test func splitsTheStreamIntoEventsWhateverTheReadBoundaries() throws {
    var stream = Data([0x68, 0x32, 0x36, 0x34])
    stream += Data([0x80, 0, 0, 0, 0, 0, 0x04, 0x38, 0, 0, 0x09, 0x60])
    stream += packet(config: true, keyframe: false, [0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 2])
    stream += packet(config: false, keyframe: true, [0, 0, 0, 1, 0x65, 9])
    let whole = try {
      var demuxer = ScrcpyVideoDemuxer()
      return try demuxer.push(stream)
    }()
    #expect(
      whole == [
        .codec(ScrcpyVideoDemuxer.h264), .session(width: 1080, height: 2400),
        .packet(config: true, keyframe: false, data: Data([0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 2])),
        .packet(config: false, keyframe: true, data: Data([0, 0, 0, 1, 0x65, 9])),
      ])
    var demuxer = ScrcpyVideoDemuxer()
    var split: [ScrcpyVideoEvent] = []
    for byte in stream { split += try demuxer.push(Data([byte])) }
    #expect(split == whole)
  }

  @Test func turnsAnnexBUnitsIntoLengthPrefixedOnes() {
    let units = AnnexB.units(Data([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3]))
    #expect(units == [Data([0x67, 1, 2]), Data([0x68, 3])])
    #expect(AnnexB.lengthPrefixed(units) == Data([0, 0, 0, 3, 0x67, 1, 2, 0, 0, 0, 2, 0x68, 3]))
  }
}
