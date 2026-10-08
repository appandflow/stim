import Foundation

/// Logs main-thread stalls. A utility-queue timer pings the main queue every `interval`; the ping's latency is the
/// stall. A stall of `threshold` or more is logged when it ends, with the destination and the last CLI command, and a
/// stall that is still going after `ongoingAfter` is logged once while it lasts. The cost is four timer wakeups a
/// second and one empty block on the main queue.
public final class MainThreadWatchdog: @unchecked Sendable {
  public static let shared = MainThreadWatchdog()

  private struct State {
    var sentAt: TimeInterval?
    var reportedOngoing = false
  }

  private let interval: TimeInterval
  private let threshold: TimeInterval
  private let ongoingAfter: TimeInterval
  private let state = LockedValue(State())
  private let queue = DispatchQueue(label: "dev.stim.desktop.watchdog", qos: .utility)
  private var timer: DispatchSourceTimer?

  public init(interval: TimeInterval = 0.25, threshold: TimeInterval = 0.25, ongoingAfter: TimeInterval = 2) {
    self.interval = interval
    self.threshold = threshold
    self.ongoingAfter = ongoingAfter
  }

  public func start() {
    queue.async { [self] in
      guard timer == nil else { return }
      let timer = DispatchSource.makeTimerSource(queue: queue)
      timer.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(50))
      timer.setEventHandler { [weak self] in self?.tick() }
      timer.resume()
      self.timer = timer
    }
  }

  private func tick() {
    let now = ProcessInfo.processInfo.systemUptime
    let outstanding = state.withLock { state -> (age: TimeInterval, report: Bool)? in
      guard let sentAt = state.sentAt else {
        state.sentAt = now
        return nil
      }
      let age = now - sentAt
      let report = age >= ongoingAfter && !state.reportedOngoing
      if report { state.reportedOngoing = true }
      return (age, report)
    }
    if let outstanding {
      if outstanding.report {
        DebugLog.warning(
          .stall, "main thread blocked for over \(Int(outstanding.age * 1000)) ms and still blocked; \(Self.context())")
      }
      return
    }
    DispatchQueue.main.async { [weak self] in self?.answered() }
  }

  private func answered() {
    let finished = state.withLock { state -> (age: TimeInterval, ongoing: Bool)? in
      guard let sentAt = state.sentAt else { return nil }
      defer { state = State() }
      return (ProcessInfo.processInfo.systemUptime - sentAt, state.reportedOngoing)
    }
    guard let finished, finished.age >= threshold else { return }
    DebugLog.warning(.stall, "main thread stalled \(Int(finished.age * 1000)) ms; \(Self.context())")
  }

  private static func context() -> String {
    "destination=\(DebugLog.destination) lastCommand=\(DebugLog.lastCommand)"
  }
}
