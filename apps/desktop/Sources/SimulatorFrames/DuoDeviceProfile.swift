import Foundation

@MainActor
struct DuoDeviceProfile {
  let inner: UInt32
  let cover: UInt32
  let turns: [UInt32: Int]

  static func load(udid: String) -> DuoDeviceProfile? {
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
    let sorted = integrated.sorted { area($0) < area($1) }
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
    return DuoDeviceProfile(inner: inner.uint32Value, cover: cover.uint32Value, turns: turns)
  }

  private static func area(_ display: [String: Any]) -> Double {
    ((display["width"] as? NSNumber)?.doubleValue ?? 0) * ((display["height"] as? NSNumber)?.doubleValue ?? 0)
  }
}
