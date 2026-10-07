import Foundation

/// Keeps the Simulator options popover current while it is visible, without
/// letting a read that started before a change overwrite that change.
public struct SimulatorOptionsPolling: Sendable {
  public static let interval: Duration = .milliseconds(2500)

  private var generation = 0
  private var changing = false

  public init() {}

  public mutating func beginChange() {
    generation += 1
    changing = true
  }

  public mutating func endChange() {
    generation += 1
    changing = false
  }

  public var canStartRead: Bool { !changing }

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
