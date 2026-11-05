import Foundation

enum GrpcFraming {
  static let service = "/android.emulation.control.EmulatorController/"

  static func preface(window: UInt32) -> [UInt8] {
    var out = Array("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n".utf8)
    var settings: [UInt8] = []
    for (id, value) in [(UInt16(2), UInt32(0)), (4, window)] {
      settings += [UInt8(id >> 8), UInt8(id & 0xff)] + bigEndian(value)
    }
    out += frame(type: 4, flags: 0, stream: 0, payload: settings)
    out += frame(type: 8, flags: 0, stream: 0, payload: bigEndian(window))
    return out
  }

  static func request(method: String, message: Data, endpoint: EmulatorEndpoint, stream: UInt32) -> [UInt8] {
    var headers: [UInt8] = [0x83, 0x86]
    headers += literal(index: 4, value: service + method)
    headers += literal(index: 1, value: "127.0.0.1:\(endpoint.grpcPort)")
    headers += literal(index: 31, value: "application/grpc")
    headers += [0x00] + string("te") + string("trailers")
    if let token = endpoint.token {
      headers += literal(index: 23, value: "Bearer \(token)")
    }
    let body = [UInt8](message)
    return frame(type: 1, flags: 0x4, stream: stream, payload: headers)
      + frame(type: 0, flags: 0x1, stream: stream, payload: [0] + bigEndian(UInt32(body.count)) + body)
  }

  static func frame(type: UInt8, flags: UInt8, stream: UInt32, payload: [UInt8]) -> [UInt8] {
    let length = UInt32(payload.count)
    return [UInt8(length >> 16 & 0xff), UInt8(length >> 8 & 0xff), UInt8(length & 0xff), type, flags]
      + bigEndian(stream) + payload
  }

  static func drain(_ inbox: inout [UInt8], _ handle: (UInt8, UInt8, UInt32, ArraySlice<UInt8>) -> Void) {
    var offset = 0
    while inbox.count - offset >= 9 {
      let length = Int(inbox[offset]) << 16 | Int(inbox[offset + 1]) << 8 | Int(inbox[offset + 2])
      guard inbox.count - offset >= 9 + length else { break }
      let stream = inbox[(offset + 5)..<(offset + 9)].reduce(UInt32(0)) { $0 << 8 | UInt32($1) } & 0x7fff_ffff
      handle(inbox[offset + 3], inbox[offset + 4], stream, inbox[(offset + 9)..<(offset + 9 + length)])
      offset += 9 + length
    }
    inbox.removeFirst(offset)
  }

  static func acknowledgement(type: UInt8, flags: UInt8, payload: ArraySlice<UInt8>) -> [UInt8]? {
    guard flags & 0x1 == 0 else { return nil }
    switch type {
    case 4: return frame(type: 4, flags: 0x1, stream: 0, payload: [])
    case 6: return frame(type: 6, flags: 0x1, stream: 0, payload: Array(payload))
    default: return nil
    }
  }

  static func bigEndian(_ value: UInt32) -> [UInt8] {
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
