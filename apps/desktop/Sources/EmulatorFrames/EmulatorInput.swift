import Foundation
import Network

/// Unary EmulatorController calls over one cleartext HTTP/2 connection to the
/// emulator's localhost gRPC port. Calls run one at a time, in order, because
/// the server may handle concurrent streams out of order and a touch must not
/// overtake the one before it. Response header blocks are never decoded; a
/// call ends on END_STREAM or RST_STREAM. Calls queued when the connection
/// fails are dropped, and the next call reconnects. `close` lets queued calls
/// finish first.
final class EmulatorInput {
  private static let window: UInt32 = 1 << 30

  private struct Call {
    var method: String
    var message: Data
    var completion: ((Data?) -> Void)?
  }

  private let endpoint: EmulatorEndpoint
  private let queue = DispatchQueue(label: "stim.emulator-input")
  private var connection: NWConnection?
  private var ready = false
  private var inbox: [UInt8] = []
  private var pending: [Call] = []
  private var current: (stream: UInt32, call: Call, response: [UInt8])?
  private var nextStream: UInt32 = 1
  private var closing = false

  init(endpoint: EmulatorEndpoint) {
    self.endpoint = endpoint
  }

  func call(_ method: String, _ message: Data, completion: ((Data?) -> Void)? = nil) {
    queue.async {
      self.pending.append(Call(method: method, message: message, completion: completion))
      self.connect()
      self.sendNext()
    }
  }

  func close() {
    queue.async {
      self.closing = true
      self.closeIfIdle()
    }
  }

  private func closeIfIdle() {
    if closing, current == nil, pending.isEmpty { reset() }
  }

  private func connect() {
    guard connection == nil else { return }
    let connection = NWConnection(
      host: "127.0.0.1", port: NWEndpoint.Port(integerLiteral: UInt16(endpoint.grpcPort)), using: .tcp)
    self.connection = connection
    connection.stateUpdateHandler = { [weak self, weak connection] state in
      guard let self, let connection, connection === self.connection else { return }
      switch state {
      case .ready:
        self.ready = true
        self.send(GrpcFraming.preface(window: Self.window))
        self.receive(on: connection)
        self.sendNext()
      case .waiting, .failed, .cancelled:
        self.reset()
      default:
        break
      }
    }
    connection.start(queue: queue)
  }

  private func sendNext() {
    guard ready, current == nil, !pending.isEmpty else { return }
    let call = pending.removeFirst()
    let stream = nextStream
    nextStream += 2
    current = (stream, call, [])
    send(GrpcFraming.request(method: call.method, message: call.message, endpoint: endpoint, stream: stream))
  }

  private func receive(on connection: NWConnection) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, complete, error in
      guard let self, connection === self.connection else { return }
      var buffer = self.inbox + (data.map { [UInt8]($0) } ?? [])
      self.inbox = []
      GrpcFraming.drain(&buffer) { type, flags, stream, payload in
        self.handle(type: type, flags: flags, stream: stream, payload: payload)
      }
      guard connection === self.connection else { return }
      self.inbox = buffer
      if complete || error != nil { self.reset() } else { self.receive(on: connection) }
    }
  }

  private func handle(type: UInt8, flags: UInt8, stream: UInt32, payload: ArraySlice<UInt8>) {
    if let reply = GrpcFraming.acknowledgement(type: type, flags: flags, payload: payload) {
      send(reply)
      return
    }
    if type == 7 { return reset() }
    guard let current, stream == current.stream else { return }
    switch type {
    case 0:
      var body = payload
      if flags & 0x8 != 0, let pad = body.first { body = body.dropFirst().dropLast(Int(pad)) }
      self.current?.response += body
      if flags & 0x1 != 0 { complete() }
    case 1 where flags & 0x1 != 0, 3:
      complete()
    default:
      break
    }
  }

  private func complete() {
    guard let current else { return }
    self.current = nil
    current.call.completion?(current.response.count >= 5 ? Data(current.response.dropFirst(5)) : nil)
    sendNext()
    closeIfIdle()
  }

  private func send(_ bytes: [UInt8]) {
    connection?.send(content: Data(bytes), completion: .idempotent)
  }

  private func reset() {
    connection?.cancel()
    connection = nil
    ready = false
    inbox = []
    nextStream = 1
    let dropped = (current.map { [$0.call] } ?? []) + pending
    current = nil
    pending = []
    for call in dropped { call.completion?(nil) }
  }
}
