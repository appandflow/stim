import Foundation
import Testing

@testable import SimulatorFrames

@Suite struct SimulatorAudioTests {
  @Test func acceptsMutedAndAudibleNativeVolumes() throws {
    for volume in [0, 60, 100] {
      let data = Data("{\"info\":{\"outcome\":\"success\"},\"result\":{\"deviceIdentifier\":\"ABCD\",\"volume\":\(volume)}}".utf8)
      #expect(try SimulatorAudio.parse(data, udid: "abcd") == volume)
    }
  }

  @Test func refusesAnotherDeviceAndUnsupportedOrInvalidVolumes() {
    let responses = [
      #"{"info":{"outcome":"success"},"result":{"deviceIdentifier":"other","volume":0}}"#,
      #"{"info":{"outcome":"success"},"result":{"deviceIdentifier":"abcd"}}"#,
      #"{"info":{"outcome":"failure"},"result":{"deviceIdentifier":"abcd","volume":0}}"#,
      #"{"info":{"outcome":"success"},"result":{"deviceIdentifier":"abcd","volume":101}}"#,
    ]
    for response in responses {
      #expect(throws: (any Error).self) { try SimulatorAudio.parse(Data(response.utf8), udid: "abcd") }
    }
  }
}
