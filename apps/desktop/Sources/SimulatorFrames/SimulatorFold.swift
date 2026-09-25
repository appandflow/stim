import Foundation

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
    return await withCheckedContinuation { continuation in
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
      process.arguments = ["simctl", "spawn", udid, helper.path]
      var environment = ProcessInfo.processInfo.environment
      environment["DEVELOPER_DIR"] = CoreSimulator.developerDir
      process.environment = environment
      let errors = Pipe()
      process.standardOutput = FileHandle.nullDevice
      process.standardError = errors
      process.terminationHandler = { process in
        let output = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        continuation.resume(
          returning: process.terminationStatus == 0 ? nil : output.trimmingCharacters(in: .whitespacesAndNewlines))
      }
      do {
        try process.run()
        DispatchQueue.global().asyncAfter(deadline: .now() + 40) {
          if process.isRunning { process.terminate() }
        }
      } catch {
        continuation.resume(returning: error.localizedDescription)
      }
    }
  }
}
