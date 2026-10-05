import AppKit
import IOSurface

@MainActor
public final class SimulatorDuoFrame {
  private struct Display {
    weak var view: SimulatorDisplayNSView?
    var orientation: UInt32 = 1
  }
  private var identity: String?
  private var model: DuoModelView?
  private var displays: [UInt32: Display] = [:]
  private var activeID: UInt32?
  private var angle = 180.0
  private var shown = false
  private var reported: [UInt32: Bool] = [:]

  public init() {}

  // CoreSimulator clears departing panels; external handoffs can leave blank or older snapshots.
  public func preparePostureChange() { if shown { model?.preparePanelChange() } }

  func attach(
    _ view: SimulatorDisplayNSView, udid: String, screenID: UInt32,
    activeID: UInt32?, angle: Double?, shown: Bool, onFrameSize: @escaping (CGSize?) -> Void
  ) {
    if identity != udid {
      model?.removeFromSuperview()
      model = nil
      displays = [:]
      reported = [:]
      identity = udid
      if let profile = Self.profile(udid: udid) {
        model = DuoModelView.load(innerID: profile.inner, coverID: profile.cover, nativeTurns: profile.turns)
      }
    }
    displays[screenID] = Display(view: view, orientation: displays[screenID]?.orientation ?? 1)
    self.activeID = activeID
    self.angle = angle ?? 180
    self.shown = shown && angle != nil
    view.onSurfaceChange = { [weak self] surface, orientation in
      guard let self else { return }
      self.displays[screenID]?.orientation = orientation
      self.model?.updateSurface(surface, screenID: screenID)
      self.update()
    }
    let available = model != nil && angle != nil
    if reported[screenID] != available {
      reported[screenID] = available
      let size = available ? CGSize(width: 1, height: 1) : nil
      DispatchQueue.main.async { onFrameSize(size) }
    }
    update()
  }

  private func update() {
    guard let model, let activeID, let active = displays[activeID]?.view else { return }
    for (id, display) in displays where id != activeID || !shown {
      if display.view?.duoModel != nil {
        display.view?.releaseInput()
        display.view?.duoModel = nil
      }
    }
    guard shown else { return }
    model.setPose(angle: CGFloat(angle), orientation: displays[activeID]?.orientation ?? 1, activeID: activeID)
    active.duoModel = model
  }

  private static func profile(udid: String) -> (inner: UInt32, cover: UInt32, turns: [UInt32: Int])? {
    guard let resources = SimulatorFrameArtwork.resources(udid: udid),
      Bundle(url: resources.deletingLastPathComponent().deletingLastPathComponent())?.bundleIdentifier
        == "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
      let data = try? Data(contentsOf: resources.appendingPathComponent("capabilities.plist")),
      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
      let capabilities = plist["capabilities"] as? [String: Any],
      let all = capabilities["displays"] as? [[String: Any]]
    else { return nil }
    let integrated = all.filter { $0["displayType"] as? String == "integrated" }
    guard integrated.count == 2 else { return nil }
    let sorted = integrated.sorted {
      area($0) < area($1)
    }
    guard let cover = sorted[0]["screenID"] as? NSNumber,
      let inner = sorted[1]["screenID"] as? NSNumber, cover != inner
    else { return nil }
    var turns: [UInt32: Int] = [:]
    for display in sorted {
      guard let id = display["screenID"] as? NSNumber,
        let rotation = display["nativeRotation"] as? NSNumber, rotation.intValue % 90 == 0
      else { return nil }
      turns[id.uint32Value] = (-rotation.intValue / 90 % 4 + 4) % 4
    }
    return (inner.uint32Value, cover.uint32Value, turns)
  }

  private static func area(_ display: [String: Any]) -> Double {
    ((display["width"] as? NSNumber)?.doubleValue ?? 0) * ((display["height"] as? NSNumber)?.doubleValue ?? 0)
  }
}
