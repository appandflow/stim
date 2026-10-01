import Foundation

/// Calls `tick` at once and then every `interval` while `isVisible`, and stops while it is not. The owner calls
/// `update()` whenever visibility may have changed; a tick that finds it hidden also stops the poller.
@MainActor
public final class VisiblePoller {
  private let interval: Duration
  private let isVisible: () -> Bool
  private let sleep: (Duration) async -> Void
  private let tick: () -> Void
  private var task: Task<Void, Never>?

  public init(
    interval: Duration, isVisible: @escaping () -> Bool,
    sleep: @escaping (Duration) async -> Void = { try? await Task.sleep(for: $0) },
    tick: @escaping () -> Void
  ) {
    self.interval = interval
    self.isVisible = isVisible
    self.sleep = sleep
    self.tick = tick
  }

  public func update() {
    guard isVisible() else {
      task?.cancel()
      task = nil
      return
    }
    guard task == nil else { return }
    tick()
    task = Task { [weak self, interval, sleep] in
      while !Task.isCancelled {
        await sleep(interval)
        guard !Task.isCancelled, let self else { return }
        guard self.isVisible() else {
          self.task = nil
          return
        }
        self.tick()
      }
    }
  }
}
