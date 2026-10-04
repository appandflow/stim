import Foundation

/// Where the space Stim Desktop measures lives. Stim's own directories are sized by `stim gc --json`;
/// these are the paths the app sizes itself with `du`, none of them under `$STIM_HOME`.
public struct StoragePaths: Equatable, Sendable {
  public var home: String
  public var simulatorDevices: String
  public var avds: String
  public var derivedData: String
  public var gradleCaches: String
  public var libraryCaches: String
  public var systemImages: String

  /// The AVD directory follows the Android tools: `ANDROID_AVD_HOME`, then `ANDROID_USER_HOME/avd`, then `~/.android/avd`.
  public init(home: String, environment: [String: String] = [:]) {
    self.home = home
    simulatorDevices = "\(home)/Library/Developer/CoreSimulator/Devices"
    avds =
      environment["ANDROID_AVD_HOME"] ?? environment["ANDROID_USER_HOME"].map { "\($0)/avd" } ?? "\(home)/.android/avd"
    derivedData = "\(home)/Library/Developer/Xcode/DerivedData"
    gradleCaches = "\(home)/.gradle/caches"
    libraryCaches = "\(home)/Library/Caches"
    let sdk =
      [environment["ANDROID_HOME"], environment["ANDROID_SDK_ROOT"]].compactMap { $0 }.first { !$0.isEmpty }
      ?? "\(home)/Library/Android/sdk"
    systemImages = "\(sdk.hasSuffix("/") ? String(sdk.dropLast()) : sdk)/system-images"
  }

  public func simulator(_ udid: String) -> String { "\(simulatorDevices)/\(udid)" }
  public func avd(_ name: String) -> String { "\(avds)/\(name).avd" }

  /// Directories `du` sizes entry by entry, with the depth that reaches each AVD and each system image.
  public var deviceSets: [(path: String, depth: Int)] { [(avds, 1), (systemImages, 3)] }

  public var unmanaged: [(title: String, path: String)] {
    [
      ("Xcode DerivedData", derivedData),
      ("Gradle caches", gradleCaches),
      ("~/Library/Caches", libraryCaches),
    ]
  }
}
