import CryptoKit
import Foundation
import Network

/// How a client authenticates to a paired server.
public enum NoiseCredential: Sendable {
  /// Spends a pairing token. The server's key must match `fingerprint` and must not be one of `pinned`, the keys of
  /// existing pairings, or the handshake ends before message 3, so the token is not spent.
  case firstContact(secret: Data, fingerprint: String, deviceName: String, pinned: Set<Data>)
  /// Proves the client key a pairing recorded, and requires the server key pinned at pairing.
  case returning(serverKey: Data)
}

/// A `ServerTransport` to another machine's stim-server over `ws://` or `wss://`: it runs protocol 2's Noise handshake
/// (`packages/core/noise-session.ts` `initiateNoise`), then carries each message encrypted. Messages sent during the
/// handshake wait for it. A refusal the server or this side makes, such as a changed server key, is reported as
/// `.refused`; any other failure, including a message that fails authentication, is reported as `.closed`.
@MainActor public final class NoiseClientTransport: ServerTransport {
  /// The server's authenticated static key, once message 2 has been read and the key accepted.
  public private(set) var serverKey: Data?

  private var socket: WebSocketStream?
  private var handshake: NoiseHandshake?
  private var cipher: NoiseTransportCipher?
  private var queued: [String] = []
  private var finished = false
  private var serverAnswered = false
  private var cancelTimeout: (() -> Void)?
  private let credential: NoiseCredential
  private let onVerified: @MainActor (Data) throws -> Void
  private let onEvent: @MainActor (ServerTransportEvent) -> Void

  /// stim-server pings no ordinary client, and its `ws` server answers every ping, so Desktop drives liveness itself at
  /// the interval the server pings its own links with (`METRO_LINK_PING_MS` in `packages/server/src/server.ts`).
  static let keepaliveInterval: TimeInterval = 15
  static let closeRefused: UInt16 = 4401
  static let closeBadRequest: UInt16 = 4400

  /// A factory that resolves the credential at each connection, so a forgotten pairing has nothing to send; a nil
  /// credential refuses the connection as `unauthorized` without opening one.
  public static func factory(
    timeout: TimeInterval = 15,
    credential: @escaping @MainActor () -> (clientKey: Curve25519.KeyAgreement.PrivateKey, NoiseCredential)?
  ) -> ServerTransportFactory {
    { url, onEvent in
      guard let (clientKey, resolved) = credential() else {
        let missing = ServerError(code: "unauthorized", message: "Stim Desktop has no key for this pairing. Pair again.")
        return NoiseClientTransport(refusing: missing, onEvent: onEvent)
      }
      return NoiseClientTransport(
        url: url, clientKey: clientKey, credential: resolved, timeout: timeout, onEvent: onEvent)
    }
  }

  /// `onVerified` runs with the server key once it is accepted and before message 3; throwing ends the handshake
  /// there, so a first-contact token is not spent.
  public init(
    url: URL, clientKey: Curve25519.KeyAgreement.PrivateKey, credential: NoiseCredential, timeout: TimeInterval = 15,
    onVerified: @escaping @MainActor (Data) throws -> Void = { _ in },
    onEvent: @escaping @MainActor (ServerTransportEvent) -> Void
  ) {
    self.credential = credential
    self.onVerified = onVerified
    self.onEvent = onEvent
    guard let target = Self.target(url) else {
      finished = true
      Task { @MainActor in onEvent(.closed("\(url.absoluteString) is not a ws:// or wss:// endpoint.")) }
      return
    }
    var lookup: Data?
    var psk: Data?
    if case .firstContact(let secret, _, _, _) = credential {
      let values = Noise.secretValues(secret)
      lookup = values.lookup
      psk = values.psk
    }
    let prefix = Noise.prefix(lookup: lookup)
    var handshake = NoiseHandshake(psk: psk, prologue: Noise.prologue(prefix: prefix), staticKey: clientKey)
    let first: Data
    do {
      first = try handshake.writeMessage()
    } catch {
      finished = true
      Task { @MainActor in onEvent(.closed(error.localizedDescription)) }
      return
    }
    self.handshake = handshake
    let socket = WebSocketStream(
      to: target.endpoint, using: target.parameters, host: target.host, path: target.path,
      maximumMessageSize: Noise.maximumServerMessageBytes + Noise.transportOverheadBytes,
      keepalive: Self.keepaliveInterval
    ) { [weak self] event in self?.receive(event) }
    self.socket = socket
    socket.send(.binary, prefix + first)
    let timer = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(timeout))
      guard !Task.isCancelled, let self, self.cipher == nil else { return }
      self.end(.closed("The machine did not finish the handshake in time."), code: 1000, reason: "")
    }
    cancelTimeout = { timer.cancel() }
  }

  private init(refusing refusal: ServerError, onEvent: @escaping @MainActor (ServerTransportEvent) -> Void) {
    credential = .returning(serverKey: Data())
    onVerified = { _ in }
    self.onEvent = onEvent
    finished = true
    Task { @MainActor in onEvent(.refused(refusal)) }
  }

  public func send(_ text: String) {
    guard !finished else { return }
    guard var cipher else { return queued.append(text) }
    do {
      let frame = try cipher.encrypt(.text(text))
      self.cipher = cipher
      socket?.send(.binary, frame)
    } catch {
      end(.closed("Stim Desktop could not send a message: \(error.localizedDescription)"), code: 1009, reason: "")
    }
  }

  public func close() {
    guard !finished else { return }
    finished = true
    cancelTimeout?()
    socket?.close()
  }

  private func receive(_ event: WebSocketStream.Event) {
    guard !finished else { return }
    switch event {
    case .message(.binary, let data):
      if cipher == nil { readHandshake(data) } else { readTransport(data) }
    case .message(.text, let data):
      if cipher == nil, let code = Self.plaintextRefusal(data), ServerProtocol.refusalCodes.contains(code) {
        return end(.refused(Self.refusal(code)), code: Self.closeRefused, reason: code)
      }
      end(.closed("stim-server sent a message outside the encrypted session."), code: Self.closeBadRequest, reason: "")
    case .message: break
    case .closed(let description, let code, let reason):
      finished = true
      cancelTimeout?()
      onEvent(Self.closeEvent(description: description, code: code, reason: reason, serverAnswered: serverAnswered))
    }
  }

  private func readHandshake(_ data: Data) {
    guard var handshake else { return }
    serverAnswered = true
    let payload: Data
    do {
      payload = try handshake.readMessage(data)
    } catch {
      return end(.closed("The authentication handshake failed."), code: Self.closeRefused, reason: "handshake-failed")
    }
    guard payload.isEmpty, let key = handshake.remoteStaticKey else {
      return end(.closed("The authentication handshake failed."), code: Self.closeRefused, reason: "handshake-failed")
    }
    var payload3 = Data()
    switch credential {
    case .returning(let pinned):
      guard key == pinned else { return refuse("server-key-mismatch") }
    case .firstContact(_, let fingerprint, let deviceName, let pinned):
      guard Noise.fingerprint(key) == fingerprint else { return refuse("server-key-mismatch") }
      guard !pinned.contains(key) else {
        return end(
          .refused(ServerError(code: "already-paired", message: "Stim Desktop is already paired with this machine.")),
          code: Self.closeRefused, reason: "already-paired")
      }
      payload3 = (try? JSONSerialization.data(withJSONObject: ["name": deviceName])) ?? Data()
    }
    do {
      try onVerified(key)
    } catch {
      return end(
        .refused(ServerError(code: "pairing-not-saved", message: error.localizedDescription)), code: 1000, reason: "")
    }
    let message3: Data
    let ciphers: (send: NoiseCipherState, receive: NoiseCipherState)
    do {
      message3 = try handshake.writeMessage(payload3)
      ciphers = try handshake.split()
    } catch {
      return end(.closed("The authentication handshake failed."), code: Self.closeRefused, reason: "handshake-failed")
    }
    self.handshake = nil
    serverKey = key
    cancelTimeout?()
    socket?.send(.binary, message3)
    cipher = NoiseTransportCipher(send: ciphers.send, receive: ciphers.receive)
    let waiting = queued
    queued = []
    for text in waiting { send(text) }
  }

  private func readTransport(_ data: Data) {
    guard var cipher else { return }
    let message: NoiseTransportCipher.Message
    do {
      message = try cipher.decrypt(data)
    } catch {
      return end(
        .closed("stim-server sent a message that failed authentication."), code: Self.closeBadRequest,
        reason: "decrypt-failed")
    }
    self.cipher = cipher
    switch message {
    case .text(let text): onEvent(.text(text))
    case .binary(let data): onEvent(.data(data))
    }
  }

  private func refuse(_ code: String) {
    end(.refused(Self.refusal(code)), code: Self.closeRefused, reason: code)
  }

  private func end(_ event: ServerTransportEvent, code: UInt16, reason: String) {
    guard !finished else { return }
    finished = true
    cancelTimeout?()
    socket?.close(code: code, reason: reason)
    onEvent(event)
  }

  /// A close is a refusal when its reason is one of the phone's refusal codes, or when a protocol 1 server closes
  /// with 4400 "unexpected binary frame" before answering the handshake.
  static func closeEvent(description: String, code: UInt16?, reason: String?, serverAnswered: Bool)
    -> ServerTransportEvent
  {
    if !serverAnswered, code == closeBadRequest, reason == "unexpected binary frame" {
      return .refused(refusal("server-outdated"))
    }
    if code == closeRefused || code == closeBadRequest, let reason, ServerProtocol.refusalCodes.contains(reason) {
      return .refused(refusal(reason))
    }
    if let reason, !reason.isEmpty { return .closed("\(description) (\(reason))") }
    return .closed(description)
  }

  static func refusal(_ code: String) -> ServerError {
    let message: String
    switch code {
    case "server-outdated": message = "Update stim-server on this machine. It speaks an older protocol than Stim Desktop."
    case "server-key-mismatch":
      message = "This machine's key does not match the pairing code or the key Stim Desktop paired with."
    case "unknown-secret": message = "This pairing code expired or was already used. Show a new one on the machine."
    case "unauthorized": message = "This machine no longer knows this Mac. Pair again."
    case "protocol-unsupported": message = "This machine speaks a newer protocol. Update Stim Desktop."
    default: message = "The machine refused the connection (\(code))."
    }
    return ServerError(code: code, message: message)
  }

  private static func plaintextRefusal(_ data: Data) -> String? {
    guard case .object(let message)? = try? JSONDecoder().decode(JSONValue.self, from: data),
      case .object(let error)? = message["error"]
    else { return nil }
    return error["code"]?.string
  }

  private struct Target {
    var endpoint: NWEndpoint
    var parameters: NWParameters
    var host: String
    var path: String
  }

  private static func target(_ url: URL) -> Target? {
    guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.user == nil,
      parts.password == nil, let scheme = parts.scheme?.lowercased(), scheme == "ws" || scheme == "wss",
      let host = parts.host, !host.isEmpty
    else { return nil }
    let secure = scheme == "wss"
    let port = parts.port ?? (secure ? 443 : 80)
    guard let nwPort = NWEndpoint.Port(rawValue: UInt16(clamping: port)), (1...65535).contains(port) else { return nil }
    let bare = host.hasPrefix("[") && host.hasSuffix("]") ? String(host.dropFirst().dropLast()) : host
    let literal = bare.contains(":") ? "[\(bare)]" : bare
    return Target(
      endpoint: .hostPort(host: NWEndpoint.Host(bare), port: nwPort), parameters: secure ? .tls : .tcp,
      host: parts.port == nil ? literal : "\(literal):\(port)",
      path: parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath)
  }
}

/// Pairs with another machine's stim-server from a `stim-server pair` payload, as the phone does: a fresh client key for
/// this pairing, protocol 2's first-contact handshake with the payload's token, then `hello`.
@MainActor public enum NoisePairing {
  /// Saves the pairing to `store` once the server's key matches the fingerprint and before message 3 spends the token,
  /// then again with the server id and capabilities `hello` reports. The whole pairing is bounded by `timeout` and ends
  /// when the calling task is cancelled. A failure before message 3, or the server's refusal to record the key, forgets
  /// the pairing. Any other failure after message 3 keeps the pairing, whose key the server may have recorded, and
  /// throws `pairing-unconfirmed`.
  public static func pair(
    _ payload: PairingPayload, store: PairedServerStore, deviceName: String, clientName: String, clientVersion: String,
    timeout: TimeInterval = 15, now: @escaping () -> Date = Date.init
  ) async throws -> PairedServer {
    let clientKey = Curve25519.KeyAgreement.PrivateKey()
    let pinned = Set(try store.pairings().map(\.serverKey))
    var saved: PairedServer?
    var transport: NoiseClientTransport?
    let credential = NoiseCredential.firstContact(
      secret: payload.secret, fingerprint: payload.fingerprint, deviceName: deviceName, pinned: pinned)
    let client = ServerClient(
      endpoint: payload.endpoint, clientName: clientName, clientVersion: clientVersion,
      transport: { url, onEvent in
        let created = NoiseClientTransport(
          url: url, clientKey: clientKey, credential: credential, timeout: timeout,
          onVerified: { serverKey in
            let pairing = PairedServer(
              endpoint: payload.endpoint, name: payload.name, serverKey: serverKey,
              clientKey: clientKey.rawRepresentation, serverID: nil, capabilities: [], pairedAt: now())
            try store.save(pairing)
            saved = pairing
          },
          onEvent: onEvent)
        transport = created
        return created
      })
    defer { client.stop() }
    do {
      let hello = try await opened(client, timeout: timeout)
      guard var pairing = saved else {
        throw ServerError(code: "pairing-not-saved", message: "The pairing was not saved.")
      }
      pairing.serverID = hello.server.id
      pairing.capabilities = hello.capabilities
      if pairing.name.isEmpty { pairing.name = hello.server.name }
      try store.save(pairing)
      return pairing
    } catch {
      guard let saved else { throw error }
      let recordRefused = (error as? ServerError).map { ["unknown-secret", "unauthorized"].contains($0.code) } ?? false
      guard transport?.serverKey != nil, !recordRefused else {
        try? store.forget(id: saved.id)
        throw error
      }
      let name = saved.name.isEmpty ? "The machine" : saved.name
      throw ServerError(
        code: "pairing-unconfirmed",
        message:
          "\(name) did not confirm the pairing: \(error.localizedDescription) Stim Desktop kept it; reconnect to finish, or forget it and run `stim-server devices revoke` there for this Mac."
      )
    }
  }

  @MainActor private final class Waiter {
    var continuation: CheckedContinuation<HelloResult, Error>?

    func finish(_ result: Result<HelloResult, Error>) {
      guard let continuation else { return }
      self.continuation = nil
      continuation.resume(with: result)
    }
  }

  private static func opened(_ client: ServerClient, timeout: TimeInterval) async throws -> HelloResult {
    let waiter = Waiter()
    let cancelTimer = ServerClient.dispatchAfter(timeout) {
      waiter.finish(.failure(ServerError(code: "timeout", message: "The machine did not answer in time.")))
    }
    defer {
      cancelTimer()
      client.onState = nil
    }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        waiter.continuation = continuation
        if Task.isCancelled { return waiter.finish(.failure(CancellationError())) }
        client.onState = { state in
          switch state {
          case .open(let hello): waiter.finish(.success(hello))
          case .refused(let error): waiter.finish(.failure(error))
          case .waiting(_, let reason): waiter.finish(.failure(ServerError(code: "unreachable", message: reason)))
          case .idle, .connecting: break
          }
        }
        client.start()
      }
    } onCancel: {
      Task { @MainActor in waiter.finish(.failure(CancellationError())) }
    }
  }
}
