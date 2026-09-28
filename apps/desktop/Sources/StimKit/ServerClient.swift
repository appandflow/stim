import Foundation

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

/// One authenticated connection to stim-server, as `apps/mobile/src/lib/connection.ts` keeps it: it reconnects with
/// a delay that doubles from 1 to 30 seconds, sends each subscription again after every `hello`, and stops on a
/// refusal (`unauthorized`, `pairing-expired`, `protocol-unsupported`) until `start` runs again.
@MainActor public final class ServerClient: ReplayServer {
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

  private let clientName: String
  private let clientVersion: String
  private let auth: @MainActor () async throws -> ServerAuth
  private let makeTransport: ServerTransportFactory
  private let schedule: ServerScheduler
  private var transport: ServerTransport?
  private var nextID = 1
  private var pending: [Int: CheckedContinuation<JSONValue, Error>] = [:]
  private var subscriptions: [ObjectIdentifier: Subscription] = [:]
  private var retry = ServerClient.minimumRetry
  private var cancelReconnect: (() -> Void)?
  private var stopped = true
  private var generation = 0

  /// `auth` runs before each connection, so it can pair again after the stored device token was refused.
  public init(
    endpoint: URL, clientName: String, clientVersion: String,
    auth: @escaping @MainActor () async throws -> ServerAuth,
    transport: @escaping ServerTransportFactory = WebSocketTransport.make,
    scheduler: @escaping ServerScheduler = ServerClient.dispatchAfter
  ) {
    self.endpoint = endpoint
    self.clientName = clientName
    self.clientVersion = clientVersion
    self.auth = auth
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

  public func request(_ method: String, _ params: [String: JSONValue]) async throws -> JSONValue {
    guard isOpen, let transport else { throw ServerError(code: "not-connected", message: "Not connected to stim-server.") }
    return try await send(on: transport, method, params)
  }

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

  private func connect() {
    generation += 1
    let current = generation
    state = .connecting
    let onEvent: @MainActor (ServerTransportEvent) -> Void = { [weak self] event in
      self?.receive(event, generation: current)
    }
    Task {
      let auth: ServerAuth
      do {
        auth = try await self.auth()
      } catch {
        guard current == generation, !stopped else { return }
        scheduleReconnect(error.localizedDescription)
        return
      }
      guard current == generation, !stopped else { return }
      let transport = makeTransport(endpoint, onEvent)
      self.transport = transport
      do {
        let result = try await send(
          on: transport, "hello",
          [
            "protocol": .number(Double(ServerProtocol.version)),
            "client": .object(["name": .string(clientName), "version": .string(clientVersion)]),
            "auth": auth.json,
          ])
        guard current == generation else { return }
        let hello = try JSONDecoder().decode(HelloResult.self, from: JSONEncoder().encode(result))
        retry = Self.minimumRetry
        state = .open(hello)
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
      guard let continuation = pending.removeValue(forKey: id) else { return }
      if case .object(let error)? = message["error"] {
        let code = error["code"]?.string ?? "unknown"
        continuation.resume(throwing: ServerError(code: code, message: error["message"]?.string ?? code))
      } else {
        continuation.resume(returning: message["result"] ?? .null)
      }
      return
    }
    guard let name = message["event"]?.string, let subscription = message["subscription"]?.string else { return }
    let event = ServerEvent(name: name, subscription: subscription, fields: message)
    for sub in subscriptions.values where sub.serverID == subscription {
      if name == "error" { resubscribeLater(sub) } else { sub.retry = Self.minimumRetry }
      sub.onEvent(event)
    }
  }

  private func send(on transport: ServerTransport, _ method: String, _ params: [String: JSONValue]) async throws
    -> JSONValue
  {
    let id = nextID
    nextID += 1
    let message: JSONValue = .object(["id": .number(Double(id)), "method": .string(method), "params": .object(params)])
    let text = String(decoding: try JSONEncoder().encode(message), as: UTF8.self)
    return try await withCheckedThrowingContinuation { continuation in
      pending[id] = continuation
      transport.send(text)
    }
  }

  private func sendSubscribe(_ sub: Subscription, on transport: ServerTransport) {
    Task {
      do {
        let result = try await send(on: transport, sub.method, sub.params())
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

  private func detach(_ reason: String) {
    let transport = self.transport
    self.transport = nil
    generation += 1
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

/// A `URLSessionWebSocketTask` that reports on the main actor.
@MainActor public final class WebSocketTransport: ServerTransport {
  private let task: URLSessionWebSocketTask
  private var closed = false
  private let onEvent: @MainActor (ServerTransportEvent) -> Void

  /// Keyframes of a full-size device screen exceed URLSession's 1 MB default.
  static let maximumMessageSize = 16 * 1024 * 1024

  public static func make(_ url: URL, _ onEvent: @escaping @MainActor (ServerTransportEvent) -> Void)
    -> ServerTransport
  {
    WebSocketTransport(url: url, onEvent: onEvent)
  }

  init(url: URL, onEvent: @escaping @MainActor (ServerTransportEvent) -> Void) {
    task = URLSession.shared.webSocketTask(with: url)
    task.maximumMessageSize = Self.maximumMessageSize
    self.onEvent = onEvent
    task.resume()
    receive()
  }

  public func send(_ text: String) {
    task.send(.string(text)) { [weak self] error in
      guard let error else { return }
      Task { @MainActor in self?.end(error.localizedDescription) }
    }
  }

  public func close() {
    closed = true
    task.cancel(with: .normalClosure, reason: nil)
  }

  private func receive() {
    task.receive { [weak self] result in
      Task { @MainActor in
        guard let self, !self.closed else { return }
        switch result {
        case .success(.string(let text)): self.onEvent(.text(text))
        case .success(.data(let data)): self.onEvent(.data(data))
        case .success: break
        case .failure(let error):
          self.end(error.localizedDescription)
          return
        }
        self.receive()
      }
    }
  }

  private func end(_ reason: String) {
    guard !closed else { return }
    closed = true
    task.cancel(with: .goingAway, reason: nil)
    onEvent(.closed(reason))
  }
}
