import Foundation

#if canImport(StimKit)
  import StimKit
#endif

/// Reads live Duo hinge angles in degrees through the bundled sim-fold helper.
/// Cancelling iteration closes this stream's input and stops its monitor.
public enum SimulatorHingeAngle {
  public static func angles(udid: String) -> AsyncStream<Double> {
    AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
      guard let helper = Bundle.main.url(forResource: "sim-fold", withExtension: nil) else {
        continuation.finish()
        return
      }
      let input = Pipe()
      var environment = ProcessInfo.processInfo.environment
      environment["DEVELOPER_DIR"] = CoreSimulator.developerDir
      environment["LC_ALL"] = "en_US.UTF-8"
      do {
        let process = try ProcessStream.start(
          executable: "/usr/bin/xcrun",
          arguments: [
            "simctl", "spawn", udid, helper.path, "angles",
          ],
          cwd: "/", environment: environment,
          standardInput: input.fileHandleForReading,
          onLine: { line in
            guard line.channel == .stdout, let angle = parse(line.text) else { return }
            continuation.yield(angle)
          },
          onExit: { _ in
            input.fileHandleForWriting.closeFile()
            continuation.finish()
          }
        )
        continuation.onTermination = { _ in
          input.fileHandleForWriting.closeFile()
          guard process.isRunning else { return }
          process.interrupt()
          DispatchQueue.global().asyncAfter(deadline: .now() + 1) {
            if process.isRunning { process.terminate() }
          }
        }
      } catch {
        input.fileHandleForWriting.closeFile()
        continuation.finish()
      }
    }
  }

  static func parse(_ line: String) -> Double? {
    guard let angle = Double(line.trimmingCharacters(in: .whitespacesAndNewlines)), angle.isFinite,
      (0...180).contains(angle)
    else { return nil }
    return angle
  }
}
