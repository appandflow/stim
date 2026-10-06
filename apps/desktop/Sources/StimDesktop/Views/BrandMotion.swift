import Lottie
import SwiftUI

enum BrandMotionName: String {
  case deviceBootIos = "device-boot-ios"
  case deviceBootAndroid = "device-boot-android"
  case deviceBootWeb = "device-boot-web"
  case deviceBootMacos = "device-boot-macos"

  static func deviceWait(platform: String) -> Self {
    let animations: [String: Self] = [
      "ios": .deviceBootIos,
      "android": .deviceBootAndroid,
      "web": .deviceBootWeb,
      "macos": .deviceBootMacos,
    ]
    return animations[platform] ?? .deviceBootIos
  }
}

struct BrandMotion: View {
  var name: BrandMotionName
  var height: CGFloat
  var forcedColorScheme: ColorScheme? = nil
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    if let url = BrandAssets.motion(name, forcedColorScheme ?? colorScheme) {
      LottieView(animation: .filepath(url.path))
        .playbackMode(reduceMotion ? .paused(at: .frame(0)) : .playing(.fromProgress(0, toProgress: 1, loopMode: .loop)))
        .resizable()
        .frame(width: height * 220 / 275, height: height)
        .id(url)
        .accessibilityHidden(true)
    }
  }
}
