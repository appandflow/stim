import AppKit
import CoreGraphics
import Testing

@testable import EmulatorFrames

@Suite struct EmulatorSkinLayoutTests {
  let pixel = """
    parts {
      device { display { width 1080 height 2424 x 0 y 0 corner_radius 87 } }
      portrait { background { image back.webp } foreground { mask mask.webp cutout hole } }
    }
    layouts {
      portrait {
        width 1224 height 2570 event EV_SW:0:1
        part1 { name portrait x 0 y 0 }
        part2 { name device x 69 y 73 }
      }
    }
    """

  @Test func readsInstalledSkinApertureInsteadOfAssumingCenteredMargins() throws {
    let layout = try #require(EmulatorSkinLayout(pixel))
    #expect(layout.geometry.size == CGSize(width: 1224, height: 2570))
    #expect(layout.geometry.aperture == CGRect(x: 69, y: 73, width: 1080, height: 2424))
    #expect(layout.image == "back.webp")
    #expect(layout.mask == "mask.webp")
    #expect(layout.cornerRadius == 87)
    #expect(EmulatorSkinLayout(pixel.replacingOccurrences(of: "x 69", with: "x 200")) == nil)
    #expect(EmulatorSkinLayout(pixel.replacingOccurrences(of: "part2 { name device", with: "part2 { name unknown")) == nil)
  }

  @Test @MainActor func loadsSkinFromAndroidUserHomeAndHonorsExplicitAvdHome() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let avds = root.appendingPathComponent("avd")
    let device = avds.appendingPathComponent("frame-fixture.avd")
    let skin = root.appendingPathComponent("skin")
    try FileManager.default.createDirectory(at: device, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: skin, withIntermediateDirectories: true)
    let keys = ["ANDROID_USER_HOME", "ANDROID_AVD_HOME"]
    let previous = keys.map { ($0, ProcessInfo.processInfo.environment[$0]) }
    defer {
      for (key, value) in previous {
        if let value { setenv(key, value, 1) } else { unsetenv(key) }
      }
      try? FileManager.default.removeItem(at: root)
    }
    setenv("ANDROID_USER_HOME", root.path, 1)
    unsetenv("ANDROID_AVD_HOME")
    try "path=\(device.path)".write(to: avds.appendingPathComponent("frame-fixture.ini"), atomically: true, encoding: .utf8)
    try "skin.path=\(skin.path)\nhw.lcd.width=1080\nhw.lcd.height=2424".write(
      to: device.appendingPathComponent("config.ini"), atomically: true, encoding: .utf8)
    try pixel.replacingOccurrences(of: "back.webp", with: "back.png")
      .replacingOccurrences(of: "foreground { mask mask.webp cutout hole }", with: "")
      .write(to: skin.appendingPathComponent("layout"), atomically: true, encoding: .utf8)
    let bitmap = try #require(
      NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 8, bitsPerPixel: 32))
    for x in 0..<2 { for y in 0..<2 { bitmap.setColor(.white, atX: x, y: y) } }
    try #require(bitmap.representation(using: .png, properties: [:])).write(to: skin.appendingPathComponent("back.png"))

    let artwork = try #require(EmulatorFrameArtwork.load(avdName: "frame-fixture"))
    #expect(artwork.geometry.aperture == CGRect(x: 69, y: 73, width: 1080, height: 2424))
    setenv("ANDROID_AVD_HOME", root.appendingPathComponent("explicit-empty").path, 1)
    #expect(EmulatorFrameArtwork.load(avdName: "frame-fixture") == nil)
  }

}
