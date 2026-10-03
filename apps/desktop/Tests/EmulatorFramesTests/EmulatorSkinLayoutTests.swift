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
}
