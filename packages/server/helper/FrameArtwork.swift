import AppKit

final class FrameArtworkPublisher {
  private let load: @MainActor () -> DeviceFrameArtwork?
  private var artwork: DeviceFrameArtwork?
  private var loaded = false

  init(load: @escaping @MainActor () -> DeviceFrameArtwork?) { self.load = load }

  func send(quarterTurns: Int) {
    Task { @MainActor in
      if !loaded {
        loaded = true
        artwork = load()
      }
      guard let artwork, let images = artwork.pngLayers(quarterTurns: quarterTurns),
        images.background.count + images.foreground.count <= 10 * 1024 * 1024
      else {
        Output.notice(["deviceFrame": NSNull()])
        return
      }
      let geometry = artwork.geometry.rotated(quarterTurns: quarterTurns)
      Output.notice([
        "deviceFrame": [
          "width": geometry.size.width, "height": geometry.size.height,
          "aperture": [
            "x": geometry.aperture.minX, "y": geometry.aperture.minY,
            "width": geometry.aperture.width, "height": geometry.aperture.height,
          ],
          "cornerRadius": artwork.cornerRadius, "quarterTurns": quarterTurns,
          "background": images.background.base64EncodedString(),
          "foreground": images.foreground.base64EncodedString(),
        ]
      ])
    }
  }
}
