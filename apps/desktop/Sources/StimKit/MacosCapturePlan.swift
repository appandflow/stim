import CoreGraphics

/// The ScreenCaptureKit output for an owned macOS app window shown in Desktop on this Mac.
public struct MacosCapturePlan: Equatable, Sendable {
  public var width: Int
  public var height: Int
  public var framesPerSecond: Int

  public init(width: Int, height: Int, framesPerSecond: Int) {
    self.width = width
    self.height = height
    self.framesPerSecond = framesPerSecond
  }

  /// Captures a `window` (points, with `nativeScale` pixels per point) at the pixels its preview covers in a `shown`
  /// area (points, on a display with `backingScale`), never above the window's native pixels. The viewer runs at up
  /// to 30 frames per second and a preview tile at 5, both capped by `maxFramesPerSecond`. Nil until the window and
  /// the preview have a size.
  public static func make(
    window: CGSize, nativeScale: CGFloat, shown: CGSize, backingScale: CGFloat, viewer: Bool,
    maxFramesPerSecond: Double
  ) -> MacosCapturePlan? {
    guard window.width > 0, window.height > 0, shown.width > 0, shown.height > 0, nativeScale > 0, backingScale > 0
    else { return nil }
    let fit = min(shown.width / window.width, shown.height / window.height)
    let scale = min(nativeScale, fit * backingScale)
    let rate = min(viewer ? 30 : 5, max(maxFramesPerSecond.rounded(.down), 1))
    return MacosCapturePlan(
      width: max(Int((window.width * scale).rounded(.up)), 1), height: max(Int((window.height * scale).rounded(.up)), 1),
      framesPerSecond: Int(rate))
  }
}
