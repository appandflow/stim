import Lottie
import SwiftUI

struct StimJar: View {
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private static let light = animation(.light)
  private static let dark = animation(.dark)

  var body: some View {
    LottieView(animation: colorScheme == .dark ? Self.dark : Self.light)
      .playbackMode(
        reduceMotion ? .paused(at: .frame(0)) : .playing(.fromProgress(0, toProgress: 1, loopMode: .loop))
      )
      .resizable()
      .frame(width: 128, height: 206)
      .frame(width: 160, height: 206)
      .accessibilityHidden(true)
  }

  private static func animation(_ scheme: ColorScheme) -> LottieAnimation? {
    guard let url = BrandAssets.jar(scheme),
      let data = try? Data(contentsOf: url),
      var asset = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      var layers = asset["layers"] as? [[String: Any]]
    else { return nil }

    layers.removeAll { ["electron1", "electron2", "electron3"].contains($0["nm"] as? String ?? "") }
    for index in layers.indices where layers[index]["nm"] as? String == "lid" {
      if var shapes = layers[index]["shapes"] as? [[String: Any]] {
        shapes.removeAll { $0["nm"] as? String == "orbits" }
        layers[index]["shapes"] = shapes
      }
    }
    asset["layers"] = layers
    return try? LottieAnimation(dictionary: asset)
  }
}
