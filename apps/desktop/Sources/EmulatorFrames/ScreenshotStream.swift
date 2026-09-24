import Foundation
import Network

/// A single `streamScreenshot` call over cleartext HTTP/2 to the emulator's
/// localhost gRPC port. URLSession speaks HTTP/2 only over TLS, and the
/// emulator's endpoint is h2c, so this writes the frames itself. It never
/// decodes response header blocks: the call ends on END_STREAM, RST_STREAM,
/// GOAWAY, or a closed connection.
final class ScreenshotStream {
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
    GrpcFraming.preface(window: window)
      + GrpcFraming.request(
        method: "streamScreenshot", message: ScreenshotMessages.imageFormat(width: width, height: height),
        endpoint: endpoint, stream: 1)
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
    GrpcFraming.drain(&inbox) { type, flags, _, payload in
      if !ended { handle(type: type, flags: flags, payload: payload) }
    }
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
    default:
      if let reply = GrpcFraming.acknowledgement(type: type, flags: flags, payload: payload) { send(reply) }
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
    let increment = GrpcFraming.bigEndian(unacknowledged)
    send(
      GrpcFraming.frame(type: 8, flags: 0, stream: 0, payload: increment)
        + GrpcFraming.frame(type: 8, flags: 0, stream: 1, payload: increment))
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
}
