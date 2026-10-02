import Foundation
import StimKit

/// Reads live Duo hinge angles in degrees. Cancelling iteration interrupts
/// only this stream's monitor process; the global timeout bounds its lifetime.
public enum SimulatorHingeAngle {
  public static func angles(udid: String) -> AsyncStream<Double> {
    AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
      var environment = ProcessInfo.processInfo.environment
      environment["DEVELOPER_DIR"] = CoreSimulator.developerDir
      environment["LC_ALL"] = "en_US.UTF-8"
      do {
        let process = try ProcessStream.start(
          executable: "/usr/bin/xcrun",
          arguments: [
            "devicectl", "device", "motion", "hinge-angle", "--device", udid,
            "--session-timeout", "55", "--timeout", "60", "--change-threshold", "1", "--update-interval", "0.5",
          ],
          cwd: "/", environment: environment,
          onLine: { line in
            guard line.channel == .stdout, let angle = parse(line.text) else { return }
            continuation.yield(angle)
          },
          onExit: { _ in continuation.finish() }
        )
        continuation.onTermination = { _ in
          guard process.isRunning else { return }
          process.interrupt()
          DispatchQueue.global().asyncAfter(deadline: .now() + 1) {
            if process.isRunning { process.terminate() }
          }
        }
      } catch {
        continuation.finish()
      }
    }
  }

  // devicectl 651.13.4 streams samples only in human output; its JSON snapshot
  // is lost when this beta hangs after the session timeout or is interrupted.
  // Human output is not a stable contract, so unfamiliar or invalid lines are ignored.
  static func parse(_ line: String) -> Double? {
    let fields = line.strippingANSI.split(whereSeparator: \.isWhitespace)
    guard fields.contains("AngleValid:Y"), let marker = fields.firstIndex(of: "Angle:"),
      fields.indices.contains(marker + 1)
    else { return nil }
    let value = fields[marker + 1]
    guard value.hasSuffix("\u{00B0}"), let angle = Double(value.dropLast()), angle.isFinite,
      (0...180).contains(angle)
    else { return nil }
    return angle
  }
}
