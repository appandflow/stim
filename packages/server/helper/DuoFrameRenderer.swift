import AppKit
import CoreImage
import IOSurface

@MainActor
final class DuoFrameRenderer {
  struct Frame {
    let jpeg: Data
    let width: Int
    let height: Int
    let revision: String
    let screenID: UInt32
    let angle: Double
    let orientation: UInt32
  }

  struct Touch {
    let point: CGPoint
    let screenID: UInt32
  }

  private struct Pose: Equatable {
    let angle: Double
    let orientation: UInt32
    let screenID: UInt32
    let viewport: CGSize
  }

  private let model: DuoModelView
  private let inputModel: DuoModelView
  private var poses: [(revision: String, pose: Pose)] = []
  private var gesture: (revision: String, pose: Pose, last: CGPoint)?

  static func load(udid: String) -> DuoFrameRenderer? {
    guard let profile = DuoDeviceProfile.load(udid: udid),
      let model = DuoModelView.load(innerID: profile.inner, coverID: profile.cover, nativeTurns: profile.turns),
      let inputModel = DuoModelView.load(innerID: profile.inner, coverID: profile.cover, nativeTurns: profile.turns)
    else { return nil }
    return DuoFrameRenderer(model: model, inputModel: inputModel)
  }

  private init(model: DuoModelView, inputModel: DuoModelView) {
    self.model = model
    self.inputModel = inputModel
  }

  func render(
    surfaces: [(screenID: UInt32, surface: IOSurface?)], activeID: UInt32,
    orientation: UInt32, angle: Double, viewport: CGSize, config: Config
  ) -> Frame? {
    guard angle.isFinite, (0...180).contains(angle), viewport.width > 0, viewport.height > 0,
      activeID == model.coverID || activeID == model.innerID
    else { return nil }
    model.frame = CGRect(origin: .zero, size: viewport)
    model.layoutSubtreeIfNeeded()
    model.setPose(angle: CGFloat(angle), orientation: orientation, activeID: activeID)
    for surface in surfaces where surface.screenID == model.coverID || surface.screenID == model.innerID {
      model.updateSurface(surface.surface, screenID: surface.screenID)
    }
    guard let image = model.snapshot().cgImage(forProposedRect: nil, context: nil, hints: nil),
      let (data, width, height) = jpeg(CIImage(cgImage: image), config: config)
    else { return nil }
    model.preparePanelChange()
    let pose = Pose(angle: angle, orientation: orientation, screenID: activeID, viewport: viewport)
    let revision: String
    if let previous = poses.last, previous.pose == pose {
      revision = previous.revision
    } else {
      revision = UUID().uuidString
      poses.append((revision, pose))
      if poses.count > 32 { poses.removeFirst() }
    }
    return Frame(
      jpeg: data, width: width, height: height, revision: revision, screenID: activeID, angle: angle, orientation: orientation)
  }

  func touch(phase: TouchPhase, at point: CGPoint, revision: String) -> Touch? {
    let pose: Pose
    if phase == .down {
      guard gesture == nil, let shown = poses.first(where: { $0.revision == revision }) else { return nil }
      pose = shown.pose
    } else {
      guard let held = gesture, held.revision == revision else { return nil }
      pose = held.pose
    }
    inputModel.frame = CGRect(origin: .zero, size: pose.viewport)
    inputModel.layoutSubtreeIfNeeded()
    inputModel.setPose(angle: CGFloat(pose.angle), orientation: pose.orientation, activeID: pose.screenID)
    let location = CGPoint(x: point.x * pose.viewport.width, y: (1 - point.y) * pose.viewport.height)
    guard let native = inputModel.nativeScreenPoint(location, clamped: phase != .down) else {
      return phase == .up ? release() : nil
    }
    gesture = phase == .up ? nil : (revision, pose, native)
    return Touch(point: native, screenID: pose.screenID)
  }

  func release() -> Touch? {
    guard let held = gesture else { return nil }
    gesture = nil
    return Touch(point: held.last, screenID: held.pose.screenID)
  }
}
