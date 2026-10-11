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

/// Follows stim-server's status views: `workspaces.subscribe` for the workspace list, `machine.subscribe` for the
/// machine, `archived.list` for the archives whenever their summary changes, and `workspace.subscribe` for each
/// followed workspace, whose full environment replaces its summary. Each change yields one payload shaped like
/// `stim status --json`. `onDelivering(true)` runs with the first payload and `onDelivering(false)` when a view ends,
/// errors or is dropped, so the caller can run its own watcher meanwhile.
@MainActor public final class ServerStatusFeed {
  private let onPayload: @MainActor (Result<StatusPayload, Error>) -> Void
  private let onDelivering: @MainActor (Bool) -> Void
  private var client: ServerClient?
  private var views = StatusViews()
  private var unsubscribes: [() -> Void] = []
  private var details: [String: () -> Void] = [:]
  private var followed: Set<String> = []
  private var archivesRead: Task<Void, Never>?
  private var archivedSeen: JSONValue?
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

  /// Follows `client`'s views, or none for nil. Calling it again with the same client changes nothing.
  public func use(_ client: ServerClient?) {
    guard client !== self.client else { return }
    stop()
    self.client = client
    guard client != nil else { return }
    LaunchMilestones.reach("server-feed-subscribed")
    subscribe()
  }

  /// Keeps the full environments of `paths`, as a workspace screen shows them, instead of their summaries.
  public func follow(_ paths: Set<String>) {
    guard paths != followed else { return }
    followed = paths
    for (path, unsubscribe) in details where !paths.contains(path) {
      unsubscribe()
      details[path] = nil
      if views.setDetail(nil, for: path) == .changed, views.hasWorkspaces { decode() }
    }
    guard let client else { return }
    for path in paths where details[path] == nil {
      details[path] = client.subscribe(
        "workspace.subscribe", params: { ["workspace": .string(path)] }, onSubscribed: { _ in },
        onEvent: { [weak self] event in self?.receiveDetail(event, path: path) }, onVideo: { _ in })
    }
  }

  private func subscribe() {
    guard let client else { return }
    generation += 1
    views = StatusViews()
    archivedSeen = nil
    unsubscribes = [
      client.subscribe(
        "workspaces.subscribe", params: { [:] }, onSubscribed: { _ in },
        onEvent: { [weak self] event in self?.receiveWorkspaces(event) }, onVideo: { _ in }),
      client.subscribe(
        "machine.subscribe", params: { [:] }, onSubscribed: { _ in },
        onEvent: { [weak self] event in self?.receiveMachine(event) }, onVideo: { _ in }),
    ]
    let paths = followed
    followed = []
    follow(paths)
  }

  private func stop(keepDelivering: Bool = false) {
    for unsubscribe in unsubscribes { unsubscribe() }
    unsubscribes = []
    for unsubscribe in details.values { unsubscribe() }
    details = [:]
    archivesRead?.cancel()
    archivesRead = nil
    generation += 1
    if !keepDelivering { delivering = false }
  }

  /// An `error` event ends a view until the client subscribes it again, which it does on its own; the caller runs its
  /// own watcher until the next payload.
  private func ended(_ event: ServerEvent) -> Bool {
    guard event.name == "error" else { return false }
    DebugLog.warning(.server, "a status view ended with an error: \(event.error?.code ?? "unknown")")
    generation += 1
    archivedSeen = nil
    delivering = false
    return true
  }

  private func receiveWorkspaces(_ event: ServerEvent) {
    if ended(event) { return }
    guard event.name == "workspaces" else { return }
    switch views.applyWorkspaces(event.fields) {
    case .gap:
      DebugLog.warning(.server, "status views missed an event; subscribing again")
      stop(keepDelivering: true)
      subscribe()
    case .unchanged: return
    case .changed:
      LaunchMilestones.reach("first-server-status")
      readArchivesIfChanged()
      decode()
    }
  }

  private func receiveMachine(_ event: ServerEvent) {
    if ended(event) { return }
    guard event.name == "machine", views.applyMachine(event.fields) == .changed, views.hasWorkspaces else { return }
    decode()
  }

  private func receiveDetail(_ event: ServerEvent, path: String) {
    guard event.name == "workspace", followed.contains(path) else { return }
    if views.setDetail(event.fields["environment"], for: path) == .changed, views.hasWorkspaces { decode() }
  }

  private func readArchivesIfChanged() {
    guard let summary = views.archivedSummary, summary != archivedSeen, let client else { return }
    archivedSeen = summary
    archivesRead?.cancel()
    let generation = generation
    archivesRead = Task { [weak self] in
      var archived: [JSONValue] = []
      var usage: JSONValue?
      var before: String?
      do {
        repeat {
          let page = try await client.request("archived.list", before.map { ["before": .string($0)] } ?? [:])
          guard case .object(let fields) = page, case .array(let entries)? = fields["archived"] else {
            self?.forgetArchives(summary, generation: generation)
            return
          }
          archived += entries
          usage = fields["usage"]
          before = fields["next"]?.string
        } while before != nil && !Task.isCancelled
      } catch {
        DebugLog.warning(.server, "archived.list failed: \(error.localizedDescription)")
        self?.forgetArchives(summary, generation: generation)
        return
      }
      guard let self, !Task.isCancelled, generation == self.generation else { return }
      self.views.setArchives(archived, usage: usage)
      self.decode()
    }
  }

  /// Lets the next archives summary read the archives again, after the read of `summary` did not finish, unless the
  /// views were subscribed again or a newer read already replaced it.
  private func forgetArchives(_ summary: JSONValue, generation: Int) {
    if generation == self.generation, archivedSeen == summary { archivedSeen = nil }
  }

  private func decode() {
    issued += 1
    let sequence = issued
    let generation = generation
    let payload = views.payload()
    Task.detached(priority: .userInitiated) { [weak self] in
      let result = Result { try decodeReporting(StatusPayload.self, from: payload, source: .server) }
      await LaunchMilestones.reach("first-server-payload-decoded")
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
