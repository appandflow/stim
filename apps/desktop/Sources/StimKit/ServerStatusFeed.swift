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
/// errors or is dropped, so the caller can mark its retained status as unavailable. `onPayload` includes its authenticated
/// client and transport generation so consumers can reject retained snapshots after reconnect. For a paired server's
/// client, the debug log gets no server-supplied text: only fixed messages and a decode failure's sanitized path.
@MainActor public final class ServerStatusFeed {
  private let onPayload: @MainActor (Result<StatusPayload, Error>, ServerClient, Int) -> Void
  private let onDelivering: @MainActor (Bool) -> Void
  private var client: ServerClient?
  private weak var viewsClient: ServerClient?
  private var views = StatusViews()
  private var unsubscribes: [() -> Void] = []
  private var details: [String: () -> Void] = [:]
  private var followed: Set<String> = []
  private var archivesRead: Task<Void, Never>?
  private var archivedSeen: JSONValue?
  private var generation = 0
  private var connectionGeneration: Int?
  private var issued = 0
  private var shown = 0
  private var failures: [String: Error] = [:]
  private var loggedDecodeFailure: String?
  private static let pairedArchivePages = 500
  private static let pairedArchiveBytes = 32 * 1024 * 1024
  private var refreshing = false
  private var refreshPending = false
  private var delivering = false {
    didSet { if delivering != oldValue { onDelivering(delivering) } }
  }

  public init(
    onPayload: @escaping @MainActor (Result<StatusPayload, Error>, ServerClient, Int) -> Void,
    onDelivering: @escaping @MainActor (Bool) -> Void
  ) {
    self.onPayload = onPayload
    self.onDelivering = onDelivering
  }

  /// Follows `client`'s views, or none for nil. Calling it again with the same client changes nothing.
  public func use(_ client: ServerClient?) {
    guard client !== self.client else { return }
    stop()
    refreshing = false
    refreshPending = false
    self.client = client
    if let client, client !== viewsClient {
      views = StatusViews()
      failures = [:]
      viewsClient = client
    }
    guard let client else { return }
    if !client.isRemote { LaunchMilestones.reach("server-feed-subscribed") }
    subscribe()
  }

  /// Requests fresh server views, coalescing requests made before their first payload into one more refresh.
  public func refresh() {
    guard client != nil else { return }
    guard !refreshing else {
      refreshPending = true
      return
    }
    refreshing = true
    stop(keepDelivering: true)
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
    connectionGeneration = client.generation
    views = StatusViews(retainingMachineAndArchives: views)
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

  private func failed(_ view: String, error: Error) {
    failures[view] = error
    report(error)
  }

  private func recovered(_ view: String) {
    guard failures.removeValue(forKey: view) != nil else { return }
    if let remaining = failures.values.first { report(remaining) }
  }

  private func report(_ error: Error) {
    issued += 1
    shown = issued
    delivering = false
    refreshing = false
    refreshPending = false
    if let client { onPayload(.failure(error), client, client.generation) }
  }

  /// Reports an ended view while the client handles resubscription, retaining the last delivered payload.
  private func ended(_ event: ServerEvent, view: String) -> Bool {
    guard event.name == "error" else { return false }
    if client?.isRemote == true {
      DebugLog.warning(.server, "a paired server's status view ended with an error")
    } else {
      DebugLog.warning(.server, "a status view ended with an error: \(event.error?.code ?? "unknown")")
    }
    failed(view, error: event.error ?? ServerError(code: "status-failed", message: "Stim server status is unavailable."))
    return true
  }

  private func prepareViews() {
    guard let client, connectionGeneration != client.generation else { return }
    connectionGeneration = client.generation
    generation += 1
    views = StatusViews(retainingMachineAndArchives: views)
    archivedSeen = nil
    refreshing = false
    refreshPending = false
    archivesRead?.cancel()
    archivesRead = nil
    delivering = false
  }

  private func receiveWorkspaces(_ event: ServerEvent) {
    prepareViews()
    if ended(event, view: "workspaces") { return }
    guard event.name == "workspaces" else { return }
    switch views.applyWorkspaces(event.fields) {
    case .gap:
      DebugLog.warning(.server, "status views missed an event; subscribing again")
      stop(keepDelivering: true)
      subscribe()
    case .unchanged: return
    case .changed:
      recovered("workspaces")
      if client?.isRemote == false { LaunchMilestones.reach("first-server-status") }
      readArchivesIfChanged()
      decode()
    }
  }

  private func receiveMachine(_ event: ServerEvent) {
    prepareViews()
    if ended(event, view: "machine") { return }
    guard event.name == "machine", views.applyMachine(event.fields) == .changed else { return }
    recovered("machine")
    if views.hasWorkspaces { decode() }
  }

  private func receiveDetail(_ event: ServerEvent, path: String) {
    prepareViews()
    guard event.name == "workspace", followed.contains(path) else { return }
    if views.setDetail(event.fields["environment"], for: path) == .changed, views.hasWorkspaces { decode() }
  }

  private func readArchivesIfChanged() {
    guard let summary = views.archivedSummary, summary != archivedSeen, let client else { return }
    archivedSeen = summary
    archivesRead?.cancel()
    let generation = generation
    let connectionGeneration = client.generation
    let remote = client.isRemote
    archivesRead = Task { [weak self] in
      var archived: [JSONValue] = []
      var usage: JSONValue?
      var before: String?
      var cursors: Set<String> = []
      var bytes = 0
      do {
        repeat {
          let page = try await client.request("archived.list", before.map { ["before": .string($0)] } ?? [:])
          guard case .object(let fields) = page, case .array(let entries)? = fields["archived"] else {
            self?.archivesFailed(
              summary, generation: generation, client: client, connectionGeneration: connectionGeneration,
              error: ServerError(code: "bad-response", message: "Stim server returned invalid archives."))
            return
          }
          before = fields["next"]?.string
          if remote {
            bytes += (try? JSONEncoder().encode(page).count) ?? 0
            let repeated = before.map { !cursors.insert($0).inserted } ?? false
            if repeated || cursors.count >= Self.pairedArchivePages || bytes > Self.pairedArchiveBytes {
              self?.archivesFailed(
                summary, generation: generation, client: client, connectionGeneration: connectionGeneration,
                error: ServerError(code: "bad-response", message: "The paired server's archive list is too long."))
              return
            }
          }
          archived += entries
          usage = fields["usage"]
        } while before != nil && !Task.isCancelled
      } catch {
        DebugLog.warning(
          .server, remote ? "a paired server's archived.list failed" : "archived.list failed: \(error.localizedDescription)")
        self?.archivesFailed(
          summary, generation: generation, client: client, connectionGeneration: connectionGeneration, error: error)
        return
      }
      guard let self, !Task.isCancelled, generation == self.generation, client === self.client, client.isOpen,
        connectionGeneration == client.generation
      else { return }
      self.views.setArchives(archived, usage: usage)
      self.recovered("archives")
      self.decode()
    }
  }

  private func archivesFailed(
    _ summary: JSONValue, generation: Int, client: ServerClient, connectionGeneration: Int, error: Error
  ) {
    guard !Task.isCancelled, generation == self.generation, client === self.client, client.isOpen,
      connectionGeneration == client.generation, archivedSeen == summary
    else { return }
    archivedSeen = nil
    failed("archives", error: error)
  }

  private func decode() {
    guard failures.isEmpty, let client else { return }
    let connectionGeneration = client.generation
    issued += 1
    let sequence = issued
    let generation = generation
    let payload = views.payload()
    let local = !client.isRemote
    Task.detached(priority: .userInitiated) { [weak self] in
      let result = Result {
        local
          ? try decodeReporting(StatusPayload.self, from: payload, source: .server)
          : try JSONDecoder().decode(StatusPayload.self, from: JSONEncoder().encode(payload))
      }
      if local { await LaunchMilestones.reach("first-server-payload-decoded") }
      await self?.show(
        result, sequence: sequence, generation: generation, client: client, connectionGeneration: connectionGeneration)
    }
  }

  private func show(
    _ result: Result<StatusPayload, Error>, sequence: Int, generation: Int, client: ServerClient, connectionGeneration: Int
  ) {
    guard failures.isEmpty, generation == self.generation, sequence > shown, client === self.client, client.isOpen,
      connectionGeneration == client.generation
    else { return }
    shown = sequence
    if case .failure(let error) = result, client.isRemote {
      let (reason, path) = Diagnostics.describe(error)
      let line = "a paired server's status did not decode: \(reason) at \(path)"
      if line != loggedDecodeFailure { DebugLog.warning(.server, line) }
      loggedDecodeFailure = line
    }
    if case .success = result { delivering = true } else { delivering = false }
    onPayload(result, client, connectionGeneration)
    if refreshing {
      refreshing = false
      if refreshPending {
        refreshPending = false
        refresh()
      }
    }
  }
}
