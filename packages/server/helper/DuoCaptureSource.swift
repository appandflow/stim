import AppKit
import IOSurface

@MainActor
final class DuoCaptureSource {
  private let udid: String
  private let changed: () -> Void
  private let renderer: DuoFrameRenderer?
  private var requested: DuoCapture?
  private var monitor: Process?
  private var input: Pipe?
  private var angle: Double?
  private var available: Bool?

  init(udid: String, changed: @escaping () -> Void) {
    self.udid = udid
    self.changed = changed
    renderer = DuoFrameRenderer.load(udid: udid)
  }

  func configure(_ requested: DuoCapture?) -> DuoFrameRenderer.Touch? {
    self.requested = requested
    guard requested != nil, renderer != nil else {
      input?.fileHandleForWriting.closeFile()
      input = nil
      angle = nil
      publish(false)
      return renderer?.release()
    }
    if monitor == nil { startMonitor() }
    return nil
  }

  func render(
    surfaces: [(screenID: UInt32, surface: IOSurface?)], activeID: UInt32,
    orientation: UInt32, viewport: CGSize, config: Config
  ) {
    guard let requested, let renderer, let angle else { return publish(false) }
    var composed = config
    composed.maxEdge = requested.maxEdge
    let scale = min(1, CGFloat(requested.maxEdge) / max(viewport.width, viewport.height))
    let canvas = CGSize(width: viewport.width * scale, height: viewport.height * scale)
    guard
      let frame = renderer.render(
        surfaces: surfaces, activeID: activeID, orientation: orientation,
        angle: angle, viewport: canvas, config: composed
      )
    else { return publish(false) }
    Output.duoFrame(frame)
    publish(true)
  }

  func touch(_ phase: TouchPhase, point: CGPoint, revision: String) -> DuoFrameRenderer.Touch? {
    guard requested != nil else { return nil }
    return renderer?.touch(phase: phase, at: point, revision: revision)
  }

  func release() -> DuoFrameRenderer.Touch? { renderer?.release() }

  private func publish(_ next: Bool) {
    guard next != available else { return }
    available = next
    Output.notice(["duoAvailable": next])
  }

  private func startMonitor() {
    guard requested != nil, renderer != nil, monitor == nil else { return }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    process.arguments = ["hinge-monitor", udid]
    var environment = ProcessInfo.processInfo.environment
    environment["DEVELOPER_DIR"] = CoreSimulator.developerDir
    process.environment = environment
    let hold = Pipe()
    let output = Pipe()
    process.standardInput = hold
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    let buffer = DuoMonitorLines()
    output.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let bytes = handle.availableData
      if bytes.isEmpty {
        handle.readabilityHandler = nil
        return
      }
      let samples = buffer.append(bytes).compactMap(SimulatorHingeAngle.parse)
      guard let newest = samples.last else { return }
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self, self.monitor === process else { return }
          self.angle = newest
          self.changed()
        }
      }
    }
    process.terminationHandler = { [weak self] _ in
      output.fileHandleForReading.readabilityHandler = nil
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self, self.monitor === process else { return }
          self.monitor = nil
          self.input = nil
          self.angle = nil
          self.publish(false)
          self.changed()
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            MainActor.assumeIsolated { self.startMonitor() }
          }
        }
      }
    }
    do {
      try process.run()
      monitor = process
      input = hold
    } catch {
      output.fileHandleForReading.readabilityHandler = nil
      publish(false)
    }
  }
}

private final class DuoMonitorLines: @unchecked Sendable {
  private let lock = NSLock()
  private var buffer = LineBuffer()

  func append(_ data: Data) -> [String] {
    lock.lock()
    defer { lock.unlock() }
    return buffer.append(data)
  }
}
