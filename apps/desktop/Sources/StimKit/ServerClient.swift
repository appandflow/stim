import Darwin
import Foundation
import Network

/// What a transport reports: a text or binary message, or that the socket closed.
public enum ServerTransportEvent: Sendable {
  case text(String)
  case data(Data)
  case closed(String)
}

/// A WebSocket to stim-server. Messages sent before the socket opens wait for it.
@MainActor public protocol ServerTransport: AnyObject {
  func send(_ text: String)
  func close()
}

public typealias ServerTransportFactory =
  @MainActor (URL, @escaping @MainActor (ServerTransportEvent) -> Void) -> ServerTransport

/// Runs `work` after a delay and returns a function that cancels it.
public typealias ServerScheduler = @MainActor (TimeInterval, @escaping @MainActor () -> Void) -> () -> Void

/// The requests `ReplayController` makes, so tests can answer them.
@MainActor public protocol ReplayServer: AnyObject {
  func request(_ method: String, _ params: [String: JSONValue]) async throws -> JSONValue
  func subscribe(
    _ method: String, params: @escaping @MainActor () -> [String: JSONValue],
    onSubscribed: @escaping @MainActor ([String: JSONValue]) -> Void,
    onEvent: @escaping @MainActor (ServerEvent) -> Void,
    onVideo: @escaping @MainActor (VideoPacket) -> Void
  ) -> () -> Void
}

/// A `ReplayServer` that also reports the control sessions the server ends.
@MainActor public protocol DeviceServer: ReplayServer {
  /// Runs `onEnded` for each `control-ended` event, and with a nil session when the connection drops.
  func observeControlEnded(_ onEnded: @escaping @MainActor (ControlEnded) -> Void) -> () -> Void
}

/// One connection to stim-server over its Unix socket, as `apps/mobile/src/lib/connection.ts` keeps one: it reconnects
/// with a delay that doubles from 1 to 30 seconds, sends each subscription again after every `hello`, and stops on a
/// refusal (`unauthorized`, `pairing-expired`, `protocol-unsupported`) until `start` runs again.
@MainActor public final class ServerClient: DeviceServer {
  public enum State: Equatable, Sendable {
    case idle
    case connecting
    case open(HelloResult)
    case waiting(retryIn: TimeInterval, reason: String)
    case refused(ServerError)
  }

  nonisolated static let minimumRetry: TimeInterval = 1
  nonisolated static let maximumRetry: TimeInterval = 30

  private final class Subscription {
    let method: String
    let params: @MainActor () -> [String: JSONValue]
    let onSubscribed: @MainActor ([String: JSONValue]) -> Void
    let onEvent: @MainActor (ServerEvent) -> Void
    let onVideo: @MainActor (VideoPacket) -> Void
    var serverID: String?
    var reconnects = true
    var finishAcceptance: (() -> Void)?
    var retry: TimeInterval = ServerClient.minimumRetry
    var cancelRetry: (() -> Void)?

    init(
      method: String, params: @escaping @MainActor () -> [String: JSONValue],
      onSubscribed: @escaping @MainActor ([String: JSONValue]) -> Void,
      onEvent: @escaping @MainActor (ServerEvent) -> Void, onVideo: @escaping @MainActor (VideoPacket) -> Void
    ) {
      self.method = method
      self.params = params
      self.onSubscribed = onSubscribed
      self.onEvent = onEvent
      self.onVideo = onVideo
    }
  }

  public let endpoint: URL
  public private(set) var state = State.idle {
    didSet { if state != oldValue { onState?(state) } }
  }
  public var onState: (@MainActor (State) -> Void)?
  public private(set) var hasDesktopAuthority = false

  private let clientName: String
  private let clientVersion: String
  private let bootstrap: @MainActor () -> DesktopBootstrapKey?
  private let serverPort: Int?
  private let makeTransport: ServerTransportFactory
  private let schedule: ServerScheduler
  private var transport: ServerTransport?
  private var nextID = 1
  private var pending: [Int: CheckedContinuation<JSONValue, Error>] = [:]
  private var subscriptions: [ObjectIdentifier: Subscription] = [:]
  private var actionReplies: [Int: Subscription] = [:]
  private var controlObservers: [UUID: @MainActor (ControlEnded) -> Void] = [:]
  private var retry = ServerClient.minimumRetry
  private var cancelReconnect: (() -> Void)?
  private var stopped = true
  private var reportReads: [String: (id: Int, task: Task<JSONValue, Error>)] = [:]
  private var nextReportRead = 0
  var busyRetryDelays: [Duration] = [.milliseconds(250), .milliseconds(500), .seconds(1), .seconds(2), .seconds(4)]
  /// Changes whenever the active transport is replaced or dropped, including reconnects to the same server.
  public private(set) var generation = 0

  /// `endpoint` is the file URL of the server's Unix socket. With `serverPort`, the client refuses a socket whose
  /// server does not listen on that TCP port, before it sends any bootstrap proof: two servers that share a Stim home
  /// share its socket path.
  public init(
    endpoint: URL, clientName: String, clientVersion: String,
    serverPort: Int? = nil,
    bootstrap: @escaping @MainActor () -> DesktopBootstrapKey? = { nil },
    transport: @escaping ServerTransportFactory = UnixSocketTransport.make,
    scheduler: @escaping ServerScheduler = ServerClient.dispatchAfter
  ) {
    self.endpoint = endpoint
    self.clientName = clientName
    self.clientVersion = clientVersion
    self.serverPort = serverPort
    self.bootstrap = bootstrap
    self.makeTransport = transport
    self.schedule = scheduler
  }

  public static func dispatchAfter(_ delay: TimeInterval, _ work: @escaping @MainActor () -> Void) -> () -> Void {
    let task = Task { @MainActor in
      try? await Task.sleep(for: .seconds(delay))
      if !Task.isCancelled { work() }
    }
    return { task.cancel() }
  }

  public var isOpen: Bool {
    if case .open = state { return true }
    return false
  }

  public func start() {
    guard stopped else { return }
    stopped = false
    retry = Self.minimumRetry
    connect()
  }

  public func stop() {
    stopped = true
    cancelReconnect?()
    cancelReconnect = nil
    detach("Connection closed.")
    state = .idle
  }

  public func archiveDetail(_ request: ArchiveDetailRequest) async throws -> ArchiveDetail {
    let result = try await retryArchiveRead { try await self.request("archive.detail", request.params) }
    return try decodeReporting(ArchiveDetail.self, from: result, source: .server)
  }

  public func archivedLogs(_ request: ArchivedLogsRequest) async throws -> [LogRecord] {
    struct Result: Decodable { var records: [LogRecord] }
    let result = try await retryArchiveRead { try await self.request("logs.query", request.params) }
    return try decodeReporting(Result.self, from: result, source: .server).records
  }

  /// Cancellation ends only this local await and ignores a late reply, keeping shared subscriptions connected.
  /// The protocol has no request cancellation: sent work continues until completion or its server limit
  /// (60 seconds for stats), and can occupy a request slot until then.
  public func request(_ method: String, _ params: [String: JSONValue]) async throws -> JSONValue {
    try Task.checkCancellation()
    guard isOpen, let transport else { throw ServerError(code: "not-connected", message: "Not connected to stim-server.") }
    return try await send(on: transport, method, params, cancellable: true)
  }

  /// Sends a read the server can refuse with `limit-exceeded` while this connection runs its maximum number of
  /// requests, and retries it with backoff. A refusal that outlasts the retries says the server is busy instead.
  public func read(_ method: String, _ params: [String: JSONValue]) async throws -> JSONValue {
    for delay in busyRetryDelays {
      do {
        return try await request(method, params)
      } catch let error as ServerError where error.code == "limit-exceeded" {
        try await Task.sleep(for: delay)
      }
    }
    do {
      return try await request(method, params)
    } catch let error as ServerError where error.code == "limit-exceeded" {
      throw ServerError(
        code: error.code,
        message:
          "The local stim-server is still busy with earlier requests from Stim Desktop. Wait a minute and try again. If this keeps happening, quit and reopen Stim Desktop."
      )
    }
  }

  /// Reads a fresh Desktop report snapshot for `target`. A read of the same target already in flight on this connection
  /// is joined instead of sent again; otherwise the target is invalidated first, only that target when the server
  /// supports it. With `restart`, a new read is sent even while one is in flight, and later callers join it instead.
  /// A caller that is cancelled still waits for the shared read before it sees the cancellation.
  public func report(_ target: [String: JSONValue], restart: Bool = false) async throws -> JSONValue {
    let key = String(decoding: try Self.sortedEncoder.encode(JSONValue.object(target)), as: UTF8.self)
    var scope: [String: JSONValue] = [:]
    if case .open(let hello) = state, hello.features?.contains("desktop-report-invalidate-target") == true {
      scope = target
    }
    if !restart, let running = reportReads[key] {
      let value = try await running.task.value
      try Task.checkCancellation()
      return value
    }
    nextReportRead += 1
    let id = nextReportRead
    let task = Task { @MainActor [weak self, scope] () throws -> JSONValue in
      guard let self else { throw CancellationError() }
      defer { if self.reportReads[key]?.id == id { self.reportReads[key] = nil } }
      _ = try await self.read("desktop.reports.invalidate", scope)
      return try await self.read("desktop.reports.get", target)
    }
    reportReads[key] = (id, task)
    let value = try await task.value
    try Task.checkCancellation()
    return value
  }

  private static let sortedEncoder: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return encoder
  }()

  /// `onSubscribed` runs each time the server accepts the subscription, before the events it then sends; `params`
  /// is read at each of those times, so a resubscription can carry newer values.
  public func subscribe(
    _ method: String, params: @escaping @MainActor () -> [String: JSONValue],
    onSubscribed: @escaping @MainActor ([String: JSONValue]) -> Void,
    onEvent: @escaping @MainActor (ServerEvent) -> Void,
    onVideo: @escaping @MainActor (VideoPacket) -> Void
  ) -> () -> Void {
    let sub = Subscription(
      method: method, params: params, onSubscribed: onSubscribed, onEvent: onEvent, onVideo: onVideo)
    let key = ObjectIdentifier(sub)
    subscriptions[key] = sub
    if isOpen, let transport { sendSubscribe(sub, on: transport) }
    return { [weak self] in
      guard let self, let sub = self.subscriptions.removeValue(forKey: key) else { return }
      sub.cancelRetry?()
      if let id = sub.serverID, self.isOpen {
        Task { _ = try? await self.request("unsubscribe", ["subscription": .string(id)]) }
      }
    }
  }

  /// Starts one action stream without replay. Cancellation waits for acceptance and the unsubscribe reply.
  /// Events received during cancellation go only to onCancellationEvent until the reply arrives.
  public func subscribeAction(
    _ method: String, params: [String: JSONValue],
    onCancellationEvent: @escaping @MainActor (ServerEvent) -> Void = { _ in },
    onEvent: @escaping @MainActor (ServerEvent) -> Void
  ) throws -> () async throws -> Void {
    guard isOpen, let transport else {
      throw ServerError(code: "not-connected", message: "Not connected to stim-server.")
    }
    var cancelling = false
    let sub = Subscription(
      method: method, params: { params }, onSubscribed: { _ in },
      onEvent: { event in
        if cancelling { onCancellationEvent(event) } else { onEvent(event) }
      }, onVideo: { _ in })
    sub.reconnects = false
    let (acceptance, continuation) = AsyncStream<Void>.makeStream()
    sub.finishAcceptance = { continuation.finish() }
    let accepted = Task { for await _ in acceptance {} }
    let id = nextID
    nextID += 1
    let message: JSONValue = .object(["id": .number(Double(id)), "method": .string(method), "params": .object(params)])
    let text = String(decoding: try JSONEncoder().encode(message), as: UTF8.self)
    let key = ObjectIdentifier(sub)
    subscriptions[key] = sub
    actionReplies[id] = sub
    transport.send(text)
    var cancellation: Task<Void, Error>?
    return { [weak self] in
      if let cancellation { return try await cancellation.value }
      cancelling = true
      let task = Task { @MainActor [weak self] in
        defer { self?.subscriptions.removeValue(forKey: key) }
        await accepted.value
        guard let self, let id = sub.serverID, transport === self.transport, self.isOpen else { return }
        do {
          _ = try await self.send(on: transport, "unsubscribe", ["subscription": .string(id)])
        } catch let error as ServerError where error.code == "unknown-subscription" {
        }
      }
      cancellation = task
      try await task.value
    }
  }

  private func failAction(_ sub: Subscription, code: String, message: String) {
    sub.finishAcceptance?()
    sub.finishAcceptance = nil
    guard subscriptions.removeValue(forKey: ObjectIdentifier(sub)) != nil else { return }
    sub.onEvent(
      ServerEvent(
        name: "error", subscription: sub.serverID ?? "",
        fields: ["error": .object(["code": .string(code), "message": .string(message)])]))
  }

  private func connect() {
    generation += 1
    let current = generation
    state = .connecting
    let maximumPathBytes = MemoryLayout.size(ofValue: sockaddr_un().sun_path) - 1
    guard endpoint.path.utf8.count <= maximumPathBytes else {
      stopped = true
      state = .refused(
        ServerError(
          code: "socket-path-too-long",
          message:
            "The local socket path exceeds macOS's limit of \(maximumPathBytes) bytes. Use a shorter Stim home and restart Stim Desktop."
        ))
      return
    }
    let directory = endpoint.deletingLastPathComponent()
    if directory.path == "/tmp/stim-sockets-\(getuid())" {
      var directoryInfo = stat()
      var socketInfo = stat()
      guard lstat(directory.path, &directoryInfo) == 0,
        lstat(endpoint.path, &socketInfo) == 0,
        StimHome.isPrivateLocalSocket(directory: directoryInfo, socket: socketInfo)
      else {
        scheduleReconnect("The local socket and its directory must be private, user-owned and not symbolic links.")
        return
      }
    }
    let onEvent: @MainActor (ServerTransportEvent) -> Void = { [weak self] event in
      self?.receive(event, generation: current)
    }
    Task {
      guard current == generation, !stopped else { return }
      let bootstrap = self.bootstrap()
      let transport = makeTransport(endpoint, onEvent)
      self.transport = transport
      do {
        let result = try await send(
          on: transport, "hello",
          ["client": .object(["name": .string(clientName), "version": .string(clientVersion)])]
            .merging(bootstrap == nil ? [:] : ["desktopBootstrap": .bool(true)]) { $1 })
        guard current == generation else { return }
        let hello = try decodeReporting(HelloResult.self, from: result, source: .server)
        if let serverPort, !hello.isServer(onPort: serverPort) {
          throw ServerError(
            code: "other-server",
            message:
              "Another stim-server owns this Stim home's socket, not the one on port \(serverPort). Stop the other server, or give each server its own STIM_HOME."
          )
        }
        if let bootstrap, let challenge = hello.desktopBootstrap {
          guard let proof = bootstrap.clientProof(for: challenge) else {
            throw ServerError(code: "forbidden", message: "The server could not prove its private Desktop bootstrap.")
          }
          let result = try await send(on: transport, "desktop.authenticate", ["proof": .string(proof)])
          guard current == generation, transport === self.transport, !stopped else { return }
          guard case .object(let fields) = result, fields["authorized"] == .bool(true) else {
            throw ServerError(code: "forbidden", message: "The server did not authorize private Desktop access.")
          }
          hasDesktopAuthority = true
        }
        retry = Self.minimumRetry
        state = .open(hello)
        guard current == generation, transport === self.transport, !stopped else { return }
        for sub in subscriptions.values { sendSubscribe(sub, on: transport) }
      } catch {
        guard current == generation else { return }
        detach("Connection lost.")
        transport.close()
        if let refusal = error as? ServerError, refusal.refusesClient {
          stopped = true
          state = .refused(refusal)
        } else if !stopped {
          scheduleReconnect(error.localizedDescription)
        }
      }
    }
  }

  private func receive(_ event: ServerTransportEvent, generation: Int) {
    guard generation == self.generation, transport != nil else { return }
    switch event {
    case .text(let text): receive(text)
    case .data(let data):
      guard let packet = VideoPacket(data) else { return }
      for sub in subscriptions.values where sub.serverID == packet.subscription {
        sub.retry = Self.minimumRetry
        sub.onVideo(packet)
      }
    case .closed(let reason):
      detach(reason)
      if !stopped { scheduleReconnect(reason) }
    }
  }

  private func receive(_ text: String) {
    guard case .object(let message)? = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) else { return }
    if let id = message["id"]?.number.map(Int.init) {
      if let sub = actionReplies.removeValue(forKey: id) {
        if case .object(let fields)? = message["result"], let subscription = fields["subscription"]?.string {
          sub.serverID = subscription
          sub.finishAcceptance?()
          sub.finishAcceptance = nil
        } else {
          if case .object(let failure)? = message["error"] {
            failAction(
              sub, code: failure["code"]?.string ?? "unknown",
              message: failure["message"]?.string ?? "The server refused the action stream.")
          } else {
            failAction(sub, code: "bad-response", message: "The server did not accept the action stream.")
          }
        }
        return
      }
      guard let continuation = pending.removeValue(forKey: id) else { return }
      if case .object(let error)? = message["error"] {
        let code = error["code"]?.string ?? "unknown"
        continuation.resume(throwing: ServerError(code: code, message: error["message"]?.string ?? code))
      } else {
        continuation.resume(returning: message["result"] ?? .null)
      }
      return
    }
    if message["event"]?.string == "control-ended" {
      endControl(
        ControlEnded(
          session: message["session"]?.string, reason: message["reason"]?.string ?? "failed",
          message: message["message"]?.string ?? "Control ended."))
      return
    }
    guard let name = message["event"]?.string, let subscription = message["subscription"]?.string else { return }
    let event = ServerEvent(name: name, subscription: subscription, fields: message)
    for sub in subscriptions.values where sub.serverID == subscription {
      if name == "error" {
        if sub.reconnects { resubscribeLater(sub) } else { subscriptions.removeValue(forKey: ObjectIdentifier(sub)) }
      } else {
        sub.retry = Self.minimumRetry
      }
      sub.onEvent(event)
    }
  }

  private func send(
    on transport: ServerTransport, _ method: String, _ params: [String: JSONValue], cancellable: Bool = false
  ) async throws
    -> JSONValue
  {
    let id = nextID
    nextID += 1
    let message: JSONValue = .object(["id": .number(Double(id)), "method": .string(method), "params": .object(params)])
    let text = String(decoding: try JSONEncoder().encode(message), as: UTF8.self)
    return try await withTaskCancellationHandler {
      if cancellable { try Task.checkCancellation() }
      return try await withCheckedThrowingContinuation { continuation in
        pending[id] = continuation
        transport.send(text)
      }
    } onCancel: {
      guard cancellable else { return }
      Task { @MainActor [weak self] in
        self?.pending.removeValue(forKey: id)?.resume(throwing: CancellationError())
      }
    }
  }

  private func sendSubscribe(_ sub: Subscription, on transport: ServerTransport) {
    Task {
      do {
        let result: JSONValue
        if sub.params()["archive"] != nil {
          result = try await retryArchiveRead {
            guard subscriptions[ObjectIdentifier(sub)] === sub, transport === self.transport else {
              throw CancellationError()
            }
            return try await send(on: transport, sub.method, sub.params())
          }
        } else {
          result = try await send(on: transport, sub.method, sub.params())
        }
        guard case .object(let fields) = result, let id = fields["subscription"]?.string else { return }
        guard subscriptions[ObjectIdentifier(sub)] === sub, transport === self.transport else {
          if transport === self.transport, isOpen {
            _ = try? await send(on: transport, "unsubscribe", ["subscription": .string(id)])
          }
          return
        }
        sub.serverID = id
        sub.onSubscribed(fields)
      } catch {
        guard subscriptions[ObjectIdentifier(sub)] === sub, transport === self.transport else { return }
        let failure = error as? ServerError ?? ServerError(code: "subscribe-failed", message: error.localizedDescription)
        sub.onEvent(
          ServerEvent(
            name: "error", subscription: "",
            fields: ["error": .object(["code": .string(failure.code), "message": .string(failure.message)])]))
      }
    }
  }

  private func resubscribeLater(_ sub: Subscription) {
    let transport = self.transport
    let delay = sub.retry
    sub.serverID = nil
    sub.retry = min(sub.retry * 2, Self.maximumRetry)
    sub.cancelRetry = schedule(delay) { [weak self] in
      guard let self, let transport, transport === self.transport, self.isOpen,
        self.subscriptions[ObjectIdentifier(sub)] === sub
      else { return }
      sub.cancelRetry = nil
      self.sendSubscribe(sub, on: transport)
    }
  }

  public func observeControlEnded(_ onEnded: @escaping @MainActor (ControlEnded) -> Void) -> () -> Void {
    let key = UUID()
    controlObservers[key] = onEnded
    return { [weak self] in self?.controlObservers[key] = nil }
  }

  private func endControl(_ ended: ControlEnded) {
    for observer in controlObservers.values { observer(ended) }
  }

  private func detach(_ reason: String) {
    hasDesktopAuthority = false
    let transport = self.transport
    self.transport = nil
    if transport != nil { endControl(ControlEnded(session: nil, reason: "failed", message: reason)) }
    generation += 1
    for sub in actionReplies.values { sub.finishAcceptance?() }
    actionReplies.removeAll()
    for sub in subscriptions.values where !sub.reconnects {
      failAction(sub, code: "connection-lost", message: reason)
    }
    for sub in subscriptions.values {
      sub.serverID = nil
      sub.cancelRetry?()
      sub.cancelRetry = nil
    }
    let failed = pending
    pending = [:]
    for continuation in failed.values {
      continuation.resume(throwing: ServerError(code: "connection-lost", message: reason))
    }
    transport?.close()
  }

  private func scheduleReconnect(_ reason: String) {
    let delay = retry
    retry = min(retry * 2, Self.maximumRetry)
    state = .waiting(retryIn: delay, reason: reason)
    cancelReconnect = schedule(delay) { [weak self] in
      guard let self, !self.stopped else { return }
      self.cancelReconnect = nil
      self.connect()
    }
  }
}

/// A WebSocket over stim-server's Unix socket, `$STIM_HOME/server/local.sock`, reporting on the main actor.
/// URLSession cannot reach a Unix socket, and Network.framework's WebSocket protocol aborts on a Unix endpoint before
/// it sends the upgrade, so this frames a plain stream connection with `WebSocketFraming`.
@MainActor public final class UnixSocketTransport: ServerTransport {
  private let connection: NWConnection
  private let key = WebSocketFraming.newKey()
  private var reader = WebSocketFraming.Reader(maximumMessageSize: UnixSocketTransport.maximumMessageSize)
  private var handshake: Data? = Data()
  private var queued: [Data] = []
  private var closed = false
  private let onEvent: @MainActor (ServerTransportEvent) -> Void

  /// Keyframes of a full-size device screen are several megabytes.
  nonisolated static let maximumMessageSize = 16 * 1024 * 1024

  /// `socket` is the socket's file URL.
  public static func make(_ socket: URL, _ onEvent: @escaping @MainActor (ServerTransportEvent) -> Void)
    -> ServerTransport
  {
    UnixSocketTransport(path: socket.path, onEvent: onEvent)
  }

  init(path: String, onEvent: @escaping @MainActor (ServerTransportEvent) -> Void) {
    connection = NWConnection(to: .unix(path: path), using: .tcp)
    self.onEvent = onEvent
    connection.stateUpdateHandler = { [weak self] state in
      MainActor.assumeIsolated {
        guard let self else { return }
        switch state {
        case .ready: self.write(WebSocketFraming.upgradeRequest(key: self.key))
        case .failed(let error), .waiting(let error): self.end(error.localizedDescription)
        case .cancelled: self.end("Connection closed.")
        default: break
        }
      }
    }
    connection.start(queue: .main)
    receive()
  }

  public func send(_ text: String) {
    let frame = WebSocketFraming.frame(.text, Data(text.utf8))
    if handshake == nil { write(frame) } else { queued.append(frame) }
  }

  public func close() {
    guard !closed else { return }
    closed = true
    guard handshake == nil else { return connection.cancel() }
    connection.send(
      content: WebSocketFraming.frame(.close, Data([0x03, 0xE8])),
      completion: .contentProcessed { [connection] _ in connection.cancel() })
  }

  private func write(_ data: Data) {
    connection.send(
      content: data,
      completion: .contentProcessed { [weak self] error in
        guard let error else { return }
        MainActor.assumeIsolated { self?.end(error.localizedDescription) }
      })
  }

  private func receive() {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, error in
      MainActor.assumeIsolated {
        guard let self, !self.closed else { return }
        if let error { return self.end(error.localizedDescription) }
        if let data, !data.isEmpty {
          do {
            try self.read(data)
          } catch {
            return self.end(error.localizedDescription)
          }
        }
        if isComplete { return self.end("stim-server closed the connection.") }
        if !self.closed { self.receive() }
      }
    }
  }

  private func read(_ data: Data) throws {
    var frames = data
    if var head = handshake {
      head.append(data)
      guard let rest = try WebSocketFraming.readUpgrade(head, key: key) else {
        handshake = head
        return
      }
      handshake = nil
      for frame in queued { write(frame) }
      queued = []
      frames = rest
    }
    for frame in try reader.read(frames) {
      switch frame.opcode {
      case .text: onEvent(.text(String(decoding: frame.payload, as: UTF8.self)))
      case .binary: onEvent(.data(frame.payload))
      case .ping: write(WebSocketFraming.frame(.pong, frame.payload))
      case .close: return answerClose(frame.payload)
      case .pong, .continuation: break
      }
      if closed { return }
    }
  }

  /// RFC 6455 section 5.5.1: answers the server's close frame with one carrying its status code, then disconnects.
  private func answerClose(_ payload: Data) {
    guard !closed else { return }
    closed = true
    connection.send(
      content: WebSocketFraming.frame(.close, payload.prefix(2)),
      completion: .contentProcessed { [connection] _ in connection.cancel() })
    onEvent(.closed("stim-server closed the connection."))
  }

  private func end(_ reason: String) {
    guard !closed else { return }
    closed = true
    connection.cancel()
    onEvent(.closed(reason))
  }
}
