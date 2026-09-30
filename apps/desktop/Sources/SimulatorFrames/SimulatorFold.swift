import Foundation
import StimKit

/// Folds and unfolds a booted iPhone Duo simulator with the `sim-fold` helper
/// that `scripts/bundle.sh` builds from `Support/SimFold` into the app's
/// resources. Each call toggles the posture.
public enum SimulatorFold {
  public static var isAvailable: Bool { helper != nil }

  private static var helper: URL? { Bundle.main.url(forResource: "sim-fold", withExtension: nil) }

  /// Runs `xcrun simctl spawn <udid> sim-fold`, stopped after 40 seconds,
  /// and returns its error output when it fails.
  public static func toggle(udid: String) async -> String? {
    guard let helper else { return "This build of Stim Desktop has no sim-fold helper." }
    var environment = ProcessInfo.processInfo.environment
    environment["DEVELOPER_DIR"] = CoreSimulator.developerDir
    var request = ProcessRequest(
      "/usr/bin/xcrun", ["simctl", "spawn", udid, helper.path], environment: environment, timeout: 40)
    request.captureStderr = true
    do {
      let result = try await request.run()
      return result.succeeded ? nil : result.stderrText.trimmingCharacters(in: .whitespacesAndNewlines)
    } catch {
      return error.localizedDescription
    }
  }
}
