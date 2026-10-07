import Foundation

/// Finds DeviceKit's iPhone Duo model (V68.usdz). Xcode 27.0 does not ship it; Xcode 27.1 does.
public enum DuoModelAsset {
  static let relativePath =
    "SharedFrameworks/DeviceKit.framework/Versions/A/PlugIns/CoreDevicePopDeviceKitExtension.devicekitplugin/Contents/Resources/V68.usdz"

  /// The model in the selected Xcode, else in the first installed Xcode that has it.
  static func locate(selected: String, installed: [String], exists: (String) -> Bool) -> String? {
    for developerDir in [selected] + installed.filter({ $0 != selected }) {
      let path = URL(fileURLWithPath: developerDir).deletingLastPathComponent().appendingPathComponent(relativePath).path
      if exists(path) { return path }
    }
    return nil
  }

  static func reason(selected: String) -> String {
    "The iPhone Duo hardware model is not in the selected Xcode (\(URL(fileURLWithPath: selected).deletingLastPathComponent().deletingLastPathComponent().lastPathComponent)) or any other Xcode in /Applications. Xcode 27.1 or later includes it."
  }

  static var installedDeveloperDirs: [String] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: "/Applications")) ?? []
    return names.filter { $0.hasPrefix("Xcode") && $0.hasSuffix(".app") }.sorted(by: >)
      .map { "/Applications/\($0)/Contents/Developer" }
  }

  static var current: URL? {
    locate(selected: CoreSimulator.developerDir, installed: installedDeveloperDirs, exists: FileManager.default.fileExists)
      .map { URL(fileURLWithPath: $0) }
  }

  /// Why no Duo model can load, or nil when one can.
  public static var unavailableReason: String? {
    current == nil ? reason(selected: CoreSimulator.developerDir) : nil
  }
}
