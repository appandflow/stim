import Lottie
import StimKit
import SwiftUI

struct TutorialIllustration: View {
  var step: String
  var failed = false
  #if DEBUG
    var fixtureRendering = false
  #endif
  @State private var shown: String?
  @State private var bridge: String?
  @State private var generation = 0
  @State private var windowVisible = false
  @AppStorage(AppPreferences.Key.pausesHiddenFrames) private var pausesHidden = true
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  static let size = CGSize(width: 288, height: 168)

  var body: some View {
    ZStack {
      if let art = TutorialArt.load(colorScheme) {
        if rendersStatic {
          if let image = art.still(failed ? step : "\(step).still") { Image(nsImage: image).resizable() }
        } else {
          LottieView(animation: art.animation)
            .playbackMode(playback(art))
            .animationDidFinish { completed in
              if completed { bridge = nil }
            }
            .resizable()
            .background(WindowStateReader { windowVisible = $0 != .hidden })
            .id(generation)
            .transition(.opacity)
        }
      }
    }
    .aspectRatio(Self.size, contentMode: .fit)
    .accessibilityHidden(true)
    .onChange(of: step, initial: true) { _, next in show(next) }
  }

  private var rendersStatic: Bool {
    #if DEBUG
      fixtureRendering
    #else
      false
    #endif
  }

  private func show(_ next: String) {
    guard next != shown else { return }
    let marker = shown.map { "\($0)>\(next)" }
    if let marker, !reduceMotion, TutorialArt.load(colorScheme)?.markers.contains(marker) == true {
      bridge = marker
      shown = next
      return
    }
    bridge = nil
    withAnimation(shown == nil || reduceMotion ? nil : .easeInOut(duration: 0.25)) {
      shown = next
      generation += 1
    }
  }

  private func playback(_ art: TutorialArt) -> LottiePlaybackMode {
    guard let shown else { return .paused(at: .frame(0)) }
    if failed { return .paused(at: .marker(shown)) }
    if reduceMotion || (pausesHidden && !windowVisible) { return .paused(at: .marker("\(shown).still")) }
    if let bridge {
      return .playing(.fromMarker(bridge, toMarker: bridge, playEndMarkerFrame: true, loopMode: .playOnce))
    }
    return .playing(.marker(shown, loopMode: art.once.contains(shown) ? .playOnce : .loop))
  }
}

struct TutorialArt {
  let animation: LottieAnimation
  let markers: Set<String>
  let once: Set<String>

  @MainActor private static var cache: [ColorScheme: TutorialArt] = [:]

  @MainActor static func load(_ scheme: ColorScheme) -> TutorialArt? {
    if let cached = cache[scheme] { return cached }
    guard let url = BrandAssets.tutorial(scheme), let data = try? Data(contentsOf: url),
      let asset = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let animation = try? LottieAnimation(dictionary: asset)
    else { return nil }
    let modes = (asset["stim"] as? [String: Any])?["modes"] as? [String: String] ?? [:]
    let art = TutorialArt(
      animation: animation, markers: Set(animation.markerNames),
      once: Set(modes.filter { $0.value == "once" }.keys))
    cache[scheme] = art
    return art
  }

  #if DEBUG
    @MainActor func still(_ marker: String) -> NSImage? {
      guard let frame = animation.frameTime(forMarker: marker) else { return nil }
      let view = LottieAnimationView(animation: animation, configuration: LottieConfiguration(renderingEngine: .mainThread))
      view.frame = CGRect(origin: .zero, size: TutorialIllustration.size)
      view.currentFrame = frame
      view.layoutSubtreeIfNeeded()
      view.layer?.displayIfNeeded()
      guard let layer = view.layer else { return nil }
      let scale: CGFloat = 2
      let width = Int(TutorialIllustration.size.width * scale)
      let height = Int(TutorialIllustration.size.height * scale)
      guard
        let context = CGContext(
          data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
          space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return nil }
      context.translateBy(x: 0, y: CGFloat(height))
      context.scaleBy(x: scale, y: -scale)
      layer.render(in: context)
      return context.makeImage().map { NSImage(cgImage: $0, size: TutorialIllustration.size) }
    }
  #endif
}
