import Foundation
import Network

/// A client WebSocket over a stream `NWConnection`, framed with `WebSocketFraming` and reporting on the main actor.
/// Messages sent before the upgrade completes wait for it.
@MainActor final class WebSocketStream {
  enum Event: Sendable {
    case message(WebSocketFraming.Opcode, Data)
    /// The connection ended. `code` and `reason` are the peer's close frame, nil when the connection ended without one.
    case closed(description: String, code: UInt16?, reason: String?)
  }

  private let connection: NWConnection
  private let key = WebSocketFraming.newKey()
  private var reader: WebSocketFraming.Reader
  private var handshake: Data? = Data()
  private var queued: [Data] = []
  private var closed = false
  private let onEvent: @MainActor (Event) -> Void

  /// `host` is the upgrade request's `Host` header and `path` its request target.
  init(
    to endpoint: NWEndpoint, using parameters: NWParameters, host: String, path: String, maximumMessageSize: Int,
    onEvent: @escaping @MainActor (Event) -> Void
  ) {
    connection = NWConnection(to: endpoint, using: parameters)
    reader = WebSocketFraming.Reader(maximumMessageSize: maximumMessageSize)
    self.onEvent = onEvent
    connection.stateUpdateHandler = { [weak self] state in
      MainActor.assumeIsolated {
        guard let self else { return }
        switch state {
        case .ready: self.write(WebSocketFraming.upgradeRequest(key: self.key, host: host, path: path))
        case .failed(let error), .waiting(let error): self.end(error.localizedDescription)
        case .cancelled: self.end("Connection closed.")
        default: break
        }
      }
    }
    connection.start(queue: .main)
    receive()
  }

  func send(_ opcode: WebSocketFraming.Opcode, _ payload: Data) {
    guard !closed else { return }
    let frame = WebSocketFraming.frame(opcode, payload)
    if handshake == nil { write(frame) } else { queued.append(frame) }
  }

  /// Sends a close frame with `code` and `reason`, then disconnects. Nothing is reported for a close this side starts.
  func close(code: UInt16 = 1000, reason: String = "") {
    guard !closed else { return }
    closed = true
    guard handshake == nil else { return connection.cancel() }
    connection.send(
      content: WebSocketFraming.frame(.close, Data([UInt8(code >> 8), UInt8(code & 0xFF)]) + Data(reason.utf8.prefix(123))),
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
      case .text, .binary: onEvent(.message(frame.opcode, frame.payload))
      case .ping: write(WebSocketFraming.frame(.pong, frame.payload))
      case .close: return answerClose(frame.payload)
      case .pong, .continuation: break
      }
      if closed { return }
    }
  }

  /// RFC 6455 section 5.5.1: answers the server's close frame with one carrying its status code, then disconnects.
  /// Section 5.5.1 also puts the code in the first two bytes and a UTF-8 reason after them.
  private func answerClose(_ payload: Data) {
    guard !closed else { return }
    closed = true
    let bytes = [UInt8](payload)
    connection.send(
      content: WebSocketFraming.frame(.close, Data(bytes.prefix(2))),
      completion: .contentProcessed { [connection] _ in connection.cancel() })
    let code = bytes.count >= 2 ? UInt16(bytes[0]) << 8 | UInt16(bytes[1]) : nil
    let reason = bytes.count > 2 ? String(decoding: bytes[2...], as: UTF8.self) : nil
    onEvent(.closed(description: "stim-server closed the connection.", code: code, reason: reason))
  }

  private func end(_ reason: String) {
    guard !closed else { return }
    closed = true
    connection.cancel()
    onEvent(.closed(description: reason, code: nil, reason: nil))
  }
}
