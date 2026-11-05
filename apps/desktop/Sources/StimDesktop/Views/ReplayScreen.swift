import AppKit
import CoreVideo
import EmulatorFrames
import StimKit
import SwiftUI

/// Shows the H.264 footage a `ReplayController` receives.
struct ReplayScreen: NSViewRepresentable {
  @ObservedObject var controller: ReplayController
  var onPixelSizeChange: (CGSize) -> Void

  func makeNSView(context: Context) -> ReplayScreenView {
    let view = ReplayScreenView()
    view.onPixelSizeChange = onPixelSizeChange
    controller.onVideo = { [weak view] packet in view?.show(packet) }
    return view
  }

  func updateNSView(_ view: ReplayScreenView, context: Context) {
    view.onPixelSizeChange = onPixelSizeChange
  }

  static func dismantleNSView(_ view: ReplayScreenView, coordinator: ()) {
    view.invalidate()
  }
}

final class ReplayScreenView: NSView {
  private final class Decoding: @unchecked Sendable {
    var configured = false
    var decoder: H264Decoder?
  }

  var onPixelSizeChange: (CGSize) -> Void = { _ in }
  private var size: CGSize?
  private let queue = DispatchQueue(label: "dev.stim.desktop.replay-decode")
  private let decoding = Decoding()

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer = CALayer()
    layer?.contentsGravity = .resizeAspect
    layer?.minificationFilter = .trilinear
    decoding.decoder = H264Decoder { [weak self] image in
      guard let surface = CVPixelBufferGetIOSurface(image)?.takeUnretainedValue() else { return }
      DispatchQueue.main.async { self?.layer?.contents = surface }
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  @MainActor func show(_ packet: VideoPacket) {
    queue.async { [decoding] in
      guard let decoder = decoding.decoder else { return }
      if packet.keyframe { decoding.configured = decoder.configure(packet.accessUnit) }
      if decoding.configured { decoding.configured = decoder.decode(packet.accessUnit) }
    }
    let size = CGSize(width: packet.width, height: packet.height)
    if size != self.size {
      self.size = size
      onPixelSizeChange(size)
    }
  }

  func invalidate() {
    queue.async { [decoding] in decoding.decoder?.invalidate() }
  }
}
