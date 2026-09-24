import Foundation
import Network

/// A single `streamScreenshot` call over cleartext HTTP/2 to the emulator's
/// localhost gRPC port. URLSession speaks HTTP/2 only over TLS, and the
/// emulator's endpoint is h2c, so this writes the frames itself. It never
/// decodes response header blocks: the call ends on END_STREAM, RST_STREAM,
/// GOAWAY, or a closed connection.
final class ScreenshotStream {
  private static let path = "/android.emulation.control.EmulatorController/streamScreenshot"
  private static let window: UInt32 = 1 << 30

  private let connection: NWConnection
  private let queue = DispatchQueue(label: "stim.emulator-frames")
  private let request: [UInt8]
  private let onFrame: (EmulatorFrame) -> Void
  private let onEnd: () -> Void
  private var inbox: [UInt8] = []
  private var messages: [UInt8] = []
  private var unacknowledged: UInt32 = 0
  private var ended = false

  init(
    endpoint: EmulatorEndpoint, width: Int, height: Int,
    onFrame: @escaping (EmulatorFrame) -> Void, onEnd: @escaping () -> Void
  ) {
    connection = NWConnection(
      host: "127.0.0.1", port: NWEndpoint.Port(integerLiteral: UInt16(endpoint.grpcPort)), using: .tcp)
    request = Self.requestBytes(endpoint: endpoint, width: width, height: height)
    self.onFrame = onFrame
    self.onEnd = onEnd
  }

  func start() {
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready:
        guard let self else { return }
        self.send(self.request)
        self.receive()
      case .failed, .cancelled:
        self?.finish()
      default:
        break
      }
    }
    connection.start(queue: queue)
  }

  func cancel() {
    queue.async {
      self.ended = true
      self.connection.cancel()
    }
  }

  static func requestBytes(endpoint: EmulatorEndpoint, width: Int, height: Int) -> [UInt8] {
    var out = Array("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n".utf8)
    var settings: [UInt8] = []
    for (id, value) in [(UInt16(2), UInt32(0)), (4, window)] {
      settings += [UInt8(id >> 8), UInt8(id & 0xff)] + bigEndian(value)
    }
    out += frame(type: 4, flags: 0, stream: 0, payload: settings)
    out += frame(type: 8, flags: 0, stream: 0, payload: bigEndian(window))

    var headers: [UInt8] = [0x83, 0x86]
    headers += literal(index: 4, value: path)
    headers += literal(index: 1, value: "127.0.0.1:\(endpoint.grpcPort)")
    headers += literal(index: 31, value: "application/grpc")
    headers += [0x00] + string("te") + string("trailers")
    if let token = endpoint.token {
      headers += literal(index: 23, value: "Bearer \(token)")
    }
    out += frame(type: 1, flags: 0x4, stream: 1, payload: headers)

    let message = [UInt8](ScreenshotMessages.imageFormat(width: width, height: height))
    out += frame(type: 0, flags: 0x1, stream: 1, payload: [0] + bigEndian(UInt32(message.count)) + message)
    return out
  }

  private func receive() {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, complete, error in
      guard let self else { return }
      if let data { self.inbox += data }
      self.drainFrames()
      if complete || error != nil { self.finish() } else if !self.ended { self.receive() }
    }
  }

  private func drainFrames() {
    var offset = 0
    while !ended, inbox.count - offset >= 9 {
      let length = Int(inbox[offset]) << 16 | Int(inbox[offset + 1]) << 8 | Int(inbox[offset + 2])
      guard inbox.count - offset >= 9 + length else { break }
      let type = inbox[offset + 3]
      let flags = inbox[offset + 4]
      let payload = inbox[(offset + 9)..<(offset + 9 + length)]
      offset += 9 + length
      handle(type: type, flags: flags, payload: payload)
    }
    inbox.removeFirst(offset)
  }

  private func handle(type: UInt8, flags: UInt8, payload: ArraySlice<UInt8>) {
    switch type {
    case 0:
      var body = payload
      if flags & 0x8 != 0, let pad = body.first {
        body = body.dropFirst().dropLast(Int(pad))
      }
      messages += body
      acknowledge(UInt32(payload.count))
      drainMessages()
      if flags & 0x1 != 0 { finish() }
    case 1:
      if flags & 0x1 != 0 { finish() }
    case 3, 7:
      finish()
    case 4 where flags & 0x1 == 0:
      send(Self.frame(type: 4, flags: 0x1, stream: 0, payload: []))
    case 6 where flags & 0x1 == 0:
      send(Self.frame(type: 6, flags: 0x1, stream: 0, payload: Array(payload)))
    default:
      break
    }
  }

  private func drainMessages() {
    var offset = 0
    while messages.count - offset >= 5 {
      let length = messages[(offset + 1)..<(offset + 5)].reduce(0) { $0 << 8 | Int($1) }
      guard messages.count - offset >= 5 + length else { break }
      let bytes = Data(messages[(offset + 5)..<(offset + 5 + length)])
      offset += 5 + length
      if let frame = ScreenshotMessages.frame(fromImage: bytes) { onFrame(frame) }
    }
    messages.removeFirst(offset)
  }

  private func acknowledge(_ count: UInt32) {
    unacknowledged += count
    guard unacknowledged >= 1 << 24 else { return }
    let increment = Self.bigEndian(unacknowledged)
    send(Self.frame(type: 8, flags: 0, stream: 0, payload: increment) + Self.frame(type: 8, flags: 0, stream: 1, payload: increment))
    unacknowledged = 0
  }

  private func send(_ bytes: [UInt8]) {
    connection.send(content: Data(bytes), completion: .idempotent)
  }

  private func finish() {
    guard !ended else { return }
    ended = true
    connection.cancel()
    onEnd()
  }

  private static func frame(type: UInt8, flags: UInt8, stream: UInt32, payload: [UInt8]) -> [UInt8] {
    let length = UInt32(payload.count)
    return [UInt8(length >> 16 & 0xff), UInt8(length >> 8 & 0xff), UInt8(length & 0xff), type, flags]
      + bigEndian(stream) + payload
  }

  private static func bigEndian(_ value: UInt32) -> [UInt8] {
    [UInt8(value >> 24), UInt8(value >> 16 & 0xff), UInt8(value >> 8 & 0xff), UInt8(value & 0xff)]
  }

  // HPACK (RFC 7541) literal header field without indexing, name taken from
  // the static table, value as a raw (non-Huffman) string.
  private static func literal(index: Int, value: String) -> [UInt8] {
    integer(index, prefixBits: 4, flags: 0x00) + string(value)
  }

  private static func string(_ value: String) -> [UInt8] {
    let bytes = Array(value.utf8)
    return integer(bytes.count, prefixBits: 7, flags: 0x00) + bytes
  }

  private static func integer(_ value: Int, prefixBits: Int, flags: UInt8) -> [UInt8] {
    let limit = (1 << prefixBits) - 1
    if value < limit { return [flags | UInt8(value)] }
    var out = [flags | UInt8(limit)]
    var rest = value - limit
    while rest >= 0x80 {
      out.append(UInt8(rest & 0x7f) | 0x80)
      rest >>= 7
    }
    out.append(UInt8(rest))
    return out
  }
}
