import Foundation
import StimKit

@MainActor
public enum EmulatorDisplayMetrics {
  public static func load(avdName: String) -> DeviceDisplayMetrics? {
    let paths = StoragePaths(
      home: FileManager.default.homeDirectoryForCurrentUser.path, environment: ProcessInfo.processInfo.environment)
    let ini = EmulatorFrameArtwork.values(
      URL(fileURLWithPath: paths.avds).appendingPathComponent(avdName).appendingPathExtension("ini"))
    guard let path = ini["path"],
      let density = EmulatorFrameArtwork.values(URL(fileURLWithPath: path).appendingPathComponent("config.ini"))["hw.lcd.density"]
        .flatMap(Double.init),
      density.isFinite, density > 0
    else { return nil }
    // Android's hw.lcd.density specifies dp conversion, not the panel's physical DPI.
    return DeviceDisplayMetrics(pixelsPerPoint: CGFloat(density / 160))
  }
}
