import SwiftUI
import XCTest

@testable import StimDesktop

final class BuildAnimationTests: XCTestCase {
  @MainActor func testEachPlatformKeepsOnlyItsItem() throws {
    let jar: Set = ["pulse", "jar-rim", "jar-base", "jar-body"]
    func item(_ name: String) -> Set<String> { ["item-\(name)-detail", "item-\(name)-fill", "item-\(name)-outline"] }
    let expected: [String: Set<String>] = [
      "ios": jar.union(item("ios")).union(["screen-rn"]),
      "android": jar.union(item("android")).union(["screen-rn"]),
      "macos": jar.union(item("macos")),
      "web": jar.union(item("web")),
      "unknown": jar.union(item("cube")),
    ]
    for scheme in [ColorScheme.light, .dark] {
      let data = try Data(contentsOf: XCTUnwrap(BrandAssets.build(scheme)))
      let asset = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      let layers = try XCTUnwrap(asset["layers"] as? [[String: Any]])
      for (platform, names) in expected {
        let kept = StimBuildAnimation.layers(layers, platform: platform).compactMap { $0["nm"] as? String }
        XCTAssertEqual(Set(kept), names, "\(scheme) \(platform)")
        let animation = try XCTUnwrap(StimBuildAnimation.animation(scheme, platform: platform), "\(scheme) \(platform)")
        XCTAssertGreaterThan(animation.endFrame, StimBuildAnimation.builtFrame)
      }
    }
  }
}
