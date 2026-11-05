import Foundation
import Testing

@testable import EmulatorFrames

@Suite struct EmulatorAudioTests {
  @Test func readsMediaVolumeAndTheDevicesOwnRange() throws {
    let data = Data("[v] will control stream=3 (STREAM_MUSIC)\n[v] volume is 0 in range [0..15]\n".utf8)
    let volume = try EmulatorAudio.parse(data)
    #expect(volume.current == 0)
    #expect(volume.maximum == 15)
  }

  @Test func refusesUnsupportedOrInvalidVolumes() {
    for text in ["Error: no shell command implementation.", "volume is 31 in range [0..30]", "volume is 0 in range [1..15]"] {
      #expect(throws: (any Error).self) { try EmulatorAudio.parse(Data(text.utf8)) }
    }
  }
}
