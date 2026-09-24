import CoreGraphics
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
  private func image(format: UInt64, width: Int, height: Int, pixels: [UInt8], rotation: UInt8? = nil) -> Data {
    var nested = Data()
    for (field, value) in [(1, format), (3, UInt64(width)), (4, UInt64(height))] {
      ScreenshotMessages.appendVarint(UInt64(field << 3), to: &nested)
      ScreenshotMessages.appendVarint(value, to: &nested)
    }
    if let rotation { nested += Data([0x12, 0x0b, 0x08, rotation, 0x21]) + Data(repeating: 0, count: 8) }
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
    #expect(frame?.rotation == 0)
  }

  @Test func readsTheSkinRotation() {
    let frame = ScreenshotMessages.frame(
      fromImage: image(format: 1, width: 1, height: 1, pixels: [0, 0, 0, 0], rotation: 3))
    #expect(frame?.rotation == 3)
  }

  @Test func rejectsAnImageWhoseBytesDoNotMatchItsSize() {
    #expect(ScreenshotMessages.frame(fromImage: image(format: 1, width: 2, height: 2, pixels: [0, 0, 0, 0])) == nil)
  }

  @Test func rejectsANonRgbaImage() {
    #expect(ScreenshotMessages.frame(fromImage: image(format: 0, width: 1, height: 1, pixels: [0, 0, 0, 0])) == nil)
  }
}

@Suite struct InputMessageTests {
  @Test func encodesAPressedMouseEventWithVarintCoordinates() {
    #expect([UInt8](InputMessages.mouse(x: 378, y: 2208, pressed: true))
      == [0x08, 0xfa, 0x02, 0x10, 0xa0, 0x11, 0x18, 0x01])
  }

  @Test func releasesTheMouseByOmittingButtons() {
    #expect([UInt8](InputMessages.mouse(x: 0, y: 5, pressed: false)) == [0x10, 0x05])
  }

  @Test func encodesMacKeyCodesWithTheirEventType() {
    #expect([UInt8](InputMessages.key(macKeyCode: 51, down: true)) == [0x08, 0x04, 0x18, 0x33])
    #expect([UInt8](InputMessages.key(macKeyCode: 51, down: false)) == [0x08, 0x04, 0x10, 0x01, 0x18, 0x33])
  }

  @Test func encodesTextAsTheTextField() {
    #expect([UInt8](InputMessages.text("Hi")) == [0x2a, 0x02, 0x48, 0x69])
  }

  @Test func readsTheDisplaySizeFromHardwareConfig() {
    func entry(_ key: String, _ value: String) -> Data {
      let k = Data(key.utf8)
      let v = Data(value.utf8)
      let body = Data([0x0a, UInt8(k.count)]) + k + Data([0x12, UInt8(v.count)]) + v
      return Data([0x0a, UInt8(body.count)]) + body
    }
    let list = entry("hw.cpu.ncore", "4") + entry("hw.lcd.height", "2400") + entry("hw.lcd.width", "1080")
    let status = Data([0x0a, 0x04]) + Data("35.6".utf8) + Data([0x18, 0x01, 0x2a, UInt8(list.count)]) + list
    let size = InputMessages.displaySize(fromStatus: status)
    #expect(size?.width == 1080)
    #expect(size?.height == 2400)
  }

  @Test func sendsOnlyPrintableAsciiAsText() {
    #expect(isPrintableASCII("A"))
    #expect(!isPrintableASCII("\r"))
    #expect(!isPrintableASCII("\u{7f}"))
    #expect(!isPrintableASCII("\u{f702}"))
  }
}

@Suite struct DisplayPixelTests {
  let display = CGSize(width: 1080, height: 2400)

  @Test func mapsUprightFractionsToNativePixelsForEachRotation() {
    let point = CGPoint(x: 0.25, y: 0.75)
    #expect(displayPixel(point, rotation: 0, displaySize: display) == (270, 1800))
    #expect(displayPixel(point, rotation: 1, displaySize: display) == (270, 600))
    #expect(displayPixel(point, rotation: 2, displaySize: display) == (810, 600))
    #expect(displayPixel(point, rotation: 3, displaySize: display) == (810, 1800))
  }

  @Test func keepsTheFarEdgeOnTheDisplay() {
    #expect(displayPixel(CGPoint(x: 1, y: 1), rotation: 0, displaySize: display) == (1079, 2399))
  }
}

@Suite struct FramingTests {
  @Test func drainsCompleteFramesWithTheirStreamAndKeepsAPartialOne() {
    var inbox = GrpcFraming.frame(type: 1, flags: 0x5, stream: 3, payload: [0xaa])
      + GrpcFraming.frame(type: 0, flags: 0x1, stream: 5, payload: [1, 2, 3])
    let partial = Array(inbox.suffix(2))
    inbox.removeLast(2)
    var seen: [(UInt8, UInt32, [UInt8])] = []
    GrpcFraming.drain(&inbox) { type, _, stream, payload in seen.append((type, stream, Array(payload))) }
    #expect(seen.count == 1)
    #expect(seen.first?.1 == 3)
    #expect(inbox.count == 10)
    inbox += partial
    GrpcFraming.drain(&inbox) { type, _, stream, payload in seen.append((type, stream, Array(payload))) }
    #expect(seen.last?.1 == 5)
    #expect(seen.last?.2 == [1, 2, 3])
    #expect(inbox.isEmpty)
  }
}
