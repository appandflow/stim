import Foundation

/// Calls `tick` every `active` while the app is active and every `inactive` otherwise, and at once on `activate()`.
@MainActor
public final class ActivityPoller {
  private let active: Duration
  private let inactive: Duration
  private let isActive: () -> Bool
  private let sleep: (Duration) async -> Void
  private let tick: () -> Void
  private var task: Task<Void, Never>?

  public init(
    active: Duration, inactive: Duration, isActive: @escaping () -> Bool,
    sleep: @escaping (Duration) async -> Void = { try? await Task.sleep(for: $0) },
    tick: @escaping () -> Void
  ) {
    self.active = active
    self.inactive = inactive
    self.isActive = isActive
    self.sleep = sleep
    self.tick = tick
  }

  public func start() {
    guard task == nil else { return }
    task = loop()
  }

  /// Ticks now and restarts the wait, so a sleep begun while inactive does not delay the first refresh in use.
  public func activate() {
    guard task != nil else { return }
    task?.cancel()
    tick()
    task = loop()
  }

  private func loop() -> Task<Void, Never> {
    Task { [weak self] in
      while !Task.isCancelled {
        guard let self else { return }
        let interval = isActive() ? active : inactive
        await sleep(interval)
        guard !Task.isCancelled else { return }
        tick()
      }
    }
  }
}
