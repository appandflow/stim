import Foundation

/// Keeps the Simulator options popover current while it is visible, without
/// letting a read that started before a change overwrite that change.
public struct SimulatorOptionsPolling: Sendable {
  public static let interval: Duration = .milliseconds(2500)

  private var generation = 0
  private var changing = false

  public init() {}

  /// Marks the start of a user change. Reads begun before this are dropped.
  public mutating func beginChange() {
    generation += 1
    changing = true
  }

  /// Marks a change finished. Reads begun before this are dropped, because
  /// the change's own confirmed read is the newest truth.
  public mutating func endChange() {
    generation += 1
    changing = false
  }

  public var canStartRead: Bool { !changing }

  /// Call when a poll read starts; pass the result to `accepts` when it ends.
  public var token: Int { generation }

  public func accepts(_ token: Int) -> Bool { !changing && token == generation }

  /// Runs `tick` immediately, then every `interval`, until the task is cancelled.
  public static func run(
    interval: Duration = interval, _ tick: @Sendable () async -> Void
  ) async {
    while !Task.isCancelled {
      await tick()
      do { try await Task.sleep(for: interval) } catch { return }
    }
  }
}
