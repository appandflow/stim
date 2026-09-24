import Foundation
import Testing

@testable import EmulatorFrames

@Suite struct DiscoveryTests {
  @Test func readsTheGrpcEndpointFromADiscoveryFile() {
    let file = """
      emulator.build=13610412
      avd.id=stim-app
      port.serial=5604
      port.adb=5605
      cmdline="/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64" "-avd" "stim-app" "-grpc" "8604" "-grpc-use-token"
      grpc.token=abc+/def==
      grpc.port=8604
      grpc.allowlist=/sdk/emulator/lib/emulator_access.json
      """
    #expect(EmulatorDiscovery.parse(file) == EmulatorEndpoint(consolePort: 5604, grpcPort: 8604, token: "abc+/def=="))
  }

  @Test func ignoresAFileWithoutAGrpcPort() {
    #expect(EmulatorDiscovery.parse("port.serial=5604\nport.adb=5605\n") == nil)
  }

  @Test func mapsOnlyEmulatorSerialsToConsolePorts() {
    #expect(EmulatorDiscovery.consolePort(serial: "emulator-5604") == 5604)
    #expect(EmulatorDiscovery.consolePort(serial: "R58M1234ABC") == nil)
  }
}

@Suite struct ScreenshotMessageTests {
  private func image(format: UInt64, width: Int, height: Int, pixels: [UInt8]) -> Data {
    var nested = Data()
    for (field, value) in [(1, format), (3, UInt64(width)), (4, UInt64(height))] {
      ScreenshotMessages.appendVarint(UInt64(field << 3), to: &nested)
      ScreenshotMessages.appendVarint(value, to: &nested)
    }
    var out = Data([0x0a, UInt8(nested.count)]) + nested
    out += Data([0x22, UInt8(pixels.count)]) + Data(pixels)
    out += Data([0x28, 0x07, 0x30, 0x96, 0x01])
    return out
  }

  @Test func decodesAnRgbaImage() {
    let pixels: [UInt8] = [1, 2, 3, 255, 4, 5, 6, 255]
    let frame = ScreenshotMessages.frame(fromImage: image(format: 1, width: 2, height: 1, pixels: pixels))
    #expect(frame?.width == 2)
    #expect(frame?.height == 1)
    #expect(frame.map { [UInt8]($0.rgba) } == pixels)
  }

  @Test func rejectsAnImageWhoseBytesDoNotMatchItsSize() {
    #expect(ScreenshotMessages.frame(fromImage: image(format: 1, width: 2, height: 2, pixels: [0, 0, 0, 0])) == nil)
  }

  @Test func rejectsANonRgbaImage() {
    #expect(ScreenshotMessages.frame(fromImage: image(format: 0, width: 1, height: 1, pixels: [0, 0, 0, 0])) == nil)
  }
}
