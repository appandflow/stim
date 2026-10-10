import Foundation

/// The server `connection` names when it is open, allows reads and serves `stimHome`, the CLI's Stim home.
@MainActor public func readCapableServer(
  _ connection: (client: ServerClient, home: String)?, stimHome: String
) -> ServerClient? {
  guard let connection, case .open(let hello) = connection.client.state,
    hello.capabilities.contains("read"),
    URL(fileURLWithPath: connection.home).resolvingSymlinksInPath().path
      == URL(fileURLWithPath: stimHome).resolvingSymlinksInPath().path
  else { return nil }
  return connection.client
}

/// Follows stim-server's `status.subscribe` feed, which carries the payloads of the server's own
/// `stim status --watch --json`. `onDelivering(true)` runs with the first payload of a subscription and
/// `onDelivering(false)` when the feed ends, errors or is dropped, so the caller can run its own watcher meanwhile.
@MainActor public final class ServerStatusFeed {
  private let onPayload: @MainActor (Result<StatusPayload, Error>) -> Void
  private let onDelivering: @MainActor (Bool) -> Void
  private var client: ServerClient?
  private var unsubscribe: (() -> Void)?
  private var generation = 0
  private var issued = 0
  private var shown = 0
  private var delivering = false {
    didSet { if delivering != oldValue { onDelivering(delivering) } }
  }

  public init(
    onPayload: @escaping @MainActor (Result<StatusPayload, Error>) -> Void,
    onDelivering: @escaping @MainActor (Bool) -> Void
  ) {
    self.onPayload = onPayload
    self.onDelivering = onDelivering
  }

  /// Follows `client`'s feed, or none for nil. Calling it again with the same client changes nothing.
  public func use(_ client: ServerClient?) {
    guard client !== self.client else { return }
    unsubscribe?()
    unsubscribe = nil
    self.client = client
    generation += 1
    delivering = false
    guard let client else { return }
    unsubscribe = client.subscribe(
      "status.subscribe", params: { [:] }, onSubscribed: { _ in },
      onEvent: { [weak self] event in self?.receive(event) }, onVideo: { _ in })
  }

  private func receive(_ event: ServerEvent) {
    if event.name == "error" {
      generation += 1
      delivering = false
      return
    }
    guard event.name == "status", let payload = event.fields["payload"] else { return }
    issued += 1
    let sequence = issued
    let generation = generation
    Task.detached(priority: .userInitiated) { [weak self] in
      let result = Result { try decodeReporting(StatusPayload.self, from: payload, source: .server) }
      await self?.show(result, sequence: sequence, generation: generation)
    }
  }

  private func show(_ result: Result<StatusPayload, Error>, sequence: Int, generation: Int) {
    guard generation == self.generation, sequence > shown else { return }
    shown = sequence
    if case .success = result { delivering = true }
    if delivering { onPayload(result) }
  }
}
