import Foundation
import StimKit

@MainActor
public enum SimulatorDisplayMetrics {
  public static func load(udid: String) -> DeviceDisplayMetrics? {
    guard let resources = SimulatorFrameArtwork.resources(udid: udid),
      let data = try? Data(contentsOf: resources.appendingPathComponent("capabilities.plist")),
      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
      let capabilities = plist["capabilities"] as? [String: Any],
      let displays = capabilities["displays"] as? [[String: Any]]
    else { return nil }
    let integrated = displays.filter { $0["displayType"] as? String == "integrated" }
    guard integrated.count == 1, let display = integrated.first,
      let scale = display["scale"] as? NSNumber, scale.doubleValue > 0
    else { return nil }
    let dpi = (display["hdpi"] as? NSNumber).map { CGFloat(truncating: $0) }
    return DeviceDisplayMetrics(pixelsPerPoint: CGFloat(truncating: scale), pixelsPerInch: dpi)
  }
}
