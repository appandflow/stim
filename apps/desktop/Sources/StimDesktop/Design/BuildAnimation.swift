import Lottie
import StimKit
import SwiftUI

struct StimBuildAnimation: View {
  var platform: String
  @State private var windowVisible = false
  @AppStorage(AppPreferences.Key.pausesHiddenFrames) private var pausesHidden = true
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  static let builtFrame: AnimationFrameTime = 68
  @MainActor private static var cache: [String: LottieAnimation] = [:]

  var body: some View {
    LottieView(animation: Self.animation(colorScheme, platform: platform))
      .playbackMode(
        (windowVisible || !pausesHidden) && !reduceMotion
          ? .playing(.fromProgress(0, toProgress: 1, loopMode: .loop)) : .paused(at: .frame(Self.builtFrame))
      )
      .resizable()
      .accessibilityHidden(true)
      .background(WindowStateReader { windowVisible = $0 != .hidden })
  }

  @MainActor static func animation(_ scheme: ColorScheme, platform: String) -> LottieAnimation? {
    let key = "\(scheme)-\(platform)"
    if let cached = cache[key] { return cached }
    guard let url = BrandAssets.build(scheme),
      let data = try? Data(contentsOf: url),
      var asset = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let layers = asset["layers"] as? [[String: Any]]
    else { return nil }
    asset["layers"] = Self.layers(layers, platform: platform)
    let animation = try? LottieAnimation(dictionary: asset)
    cache[key] = animation
    return animation
  }

  static func layers(_ layers: [[String: Any]], platform: String) -> [[String: Any]] {
    let item = ["ios", "android", "macos", "web"].contains(platform) ? platform : "cube"
    let screen = ["ios", "android"].contains(platform) ? "screen-rn" : nil
    return layers.filter {
      let name = $0["nm"] as? String ?? ""
      if name.hasPrefix("item-") { return name.hasPrefix("item-\(item)-") }
      if name.hasPrefix("screen-") { return name == screen }
      return true
    }
  }
}
