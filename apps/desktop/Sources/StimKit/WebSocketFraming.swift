import CryptoKit
import Foundation

/// The client side of RFC 6455 that Stim Desktop needs on stim-server's Unix socket: the upgrade request and its
/// answer, masked frames out, and unmasked frames in. Network.framework's WebSocket protocol needs a URL endpoint and
/// aborts on a Unix one, so `UnixSocketTransport` frames the stream itself. No extensions are offered.
public enum WebSocketFraming {
  public enum Opcode: UInt8, Sendable {
    case continuation = 0
    case text = 1
    case binary = 2
    case close = 8
    case ping = 9
    case pong = 10
  }

  public struct Frame: Equatable, Sendable {
    public var opcode: Opcode
    public var payload: Data
  }

  public struct Failure: Error, Equatable, LocalizedError {
    public var message: String
    public var errorDescription: String? { message }
  }

  /// RFC 6455 section 1.3: the accept value is base64 of SHA-1 over the key and this GUID.
  static let acceptGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

  /// The upgrade request. Node's HTTP server answers 400 without `Host`, and stim-server refuses an `Origin` on the
  /// socket, so it sends none.
  public static func upgradeRequest(key: String) -> Data {
    Data(
      ("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        + "Sec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\n\r\n").utf8)
  }

  public static func newKey() -> String {
    Data((0..<16).map { _ in UInt8.random(in: 0...255) }).base64EncodedString()
  }

  public static func accept(for key: String) -> String {
    Data(Insecure.SHA1.hash(data: Data((key + acceptGUID).utf8))).base64EncodedString()
  }

  /// Reads the server's answer to the upgrade from the start of `buffer`: nil while its head is incomplete, else the
  /// bytes after the head, which are already frames. Throws for any answer but a 101 with the matching accept value.
  public static func readUpgrade(_ buffer: Data, key: String) throws -> Data? {
    guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else {
      if buffer.count > 16 * 1024 { throw Failure(message: "stim-server sent an oversized handshake.") }
      return nil
    }
    let head = String(decoding: buffer[buffer.startIndex..<end.lowerBound], as: UTF8.self)
    let lines = head.components(separatedBy: "\r\n")
    let status = lines.first ?? ""
    guard status.hasPrefix("HTTP/1.1 101") else {
      let code = status.split(separator: " ").dropFirst().first.map(String.init) ?? "?"
      let reason = code == "503" ? "stim-server is not ready yet." : "stim-server refused the connection (HTTP \(code))."
      throw Failure(message: reason)
    }
    let accept = lines.dropFirst().compactMap { line -> String? in
      let parts = line.split(separator: ":", maxSplits: 1)
      guard parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "sec-websocket-accept"
      else { return nil }
      return parts[1].trimmingCharacters(in: .whitespaces)
    }.first
    guard accept == Self.accept(for: key) else { throw Failure(message: "stim-server answered with a bad handshake.") }
    return Data(buffer[end.upperBound...])
  }

  /// One final frame, masked as RFC 6455 requires of every client frame.
  public static func frame(_ opcode: Opcode, _ payload: Data, mask: [UInt8] = (0..<4).map { _ in UInt8.random(in: 0...255) })
    -> Data
  {
    var out = Data([0x80 | opcode.rawValue])
    let count = payload.count
    if count < 126 {
      out.append(0x80 | UInt8(count))
    } else if count <= 0xFFFF {
      out.append(0x80 | 126)
      out.append(contentsOf: [UInt8(count >> 8), UInt8(count & 0xFF)])
    } else {
      out.append(0x80 | 127)
      out.append(contentsOf: (0..<8).reversed().map { UInt8((UInt64(count) >> (UInt64($0) * 8)) & 0xFF) })
    }
    out.append(contentsOf: mask)
    out.append(contentsOf: payload.enumerated().map { $0.element ^ mask[$0.offset % 4] })
    return out
  }

  /// Splits the server's byte stream into messages, joining fragments; control frames come out as they arrive.
  public struct Reader {
    public let maximumMessageSize: Int
    private var buffer = Data()
    private var fragments: (opcode: Opcode, payload: Data)?

    public init(maximumMessageSize: Int) {
      self.maximumMessageSize = maximumMessageSize
    }

    public mutating func read(_ bytes: Data) throws -> [Frame] {
      buffer.append(bytes)
      var frames: [Frame] = []
      while let frame = try next() { frames.append(frame) }
      return frames
    }

    private mutating func next() throws -> Frame? {
      let bytes = [UInt8](buffer.prefix(14))
      guard bytes.count >= 2 else { return nil }
      let fin = bytes[0] & 0x80 != 0
      guard bytes[0] & 0x70 == 0 else { throw Failure(message: "stim-server sent a frame with reserved bits set.") }
      guard let opcode = Opcode(rawValue: bytes[0] & 0x0F) else {
        throw Failure(message: "stim-server sent an unknown frame type.")
      }
      guard bytes[1] & 0x80 == 0 else { throw Failure(message: "stim-server sent a masked frame.") }
      var length = Int(bytes[1] & 0x7F)
      var offset = 2
      if length == 126 {
        guard bytes.count >= 4 else { return nil }
        length = Int(bytes[2]) << 8 | Int(bytes[3])
        offset = 4
      } else if length == 127 {
        guard bytes.count >= 10 else { return nil }
        let wide = bytes[2..<10].reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
        guard wide <= UInt64(maximumMessageSize) else { throw tooLarge }
        length = Int(wide)
        offset = 10
      }
      guard (fragments?.payload.count ?? 0) + length <= maximumMessageSize else { throw tooLarge }
      guard buffer.count >= offset + length else { return nil }
      let start = buffer.startIndex + offset
      let payload = Data(buffer[start..<start + length])
      buffer = Data(buffer[(start + length)...])
      switch opcode {
      case .close, .ping, .pong:
        return Frame(opcode: opcode, payload: payload)
      case .continuation:
        guard var partial = fragments else { throw Failure(message: "stim-server sent a stray continuation frame.") }
        partial.payload.append(payload)
        guard fin else {
          fragments = partial
          return try next()
        }
        fragments = nil
        return Frame(opcode: partial.opcode, payload: partial.payload)
      case .text, .binary:
        guard fragments == nil else { throw Failure(message: "stim-server interleaved two messages.") }
        guard fin else {
          fragments = (opcode, payload)
          return try next()
        }
        return Frame(opcode: opcode, payload: payload)
      }
    }

    private var tooLarge: Failure { Failure(message: "stim-server sent a message over \(maximumMessageSize) bytes.") }
  }
}
