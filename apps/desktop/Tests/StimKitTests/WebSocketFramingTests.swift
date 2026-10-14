import Foundation
import Testing

@testable import StimKit

struct WebSocketFramingTests {
  private func serverFrame(_ first: UInt8, _ payload: Data) -> Data {
    var out = Data([first])
    if payload.count < 126 {
      out.append(UInt8(payload.count))
    } else if payload.count <= 0xFFFF {
      out.append(contentsOf: [126, UInt8(payload.count >> 8), UInt8(payload.count & 0xFF)])
    } else {
      out.append(127)
      out.append(contentsOf: (0..<8).reversed().map { UInt8((UInt64(payload.count) >> (UInt64($0) * 8)) & 0xFF) })
    }
    return out + payload
  }

  @Test func masksAClientFrameAsTheRFCExampleDoes() {
    let frame = WebSocketFraming.frame(.text, Data("Hello".utf8), mask: [0x37, 0xFA, 0x21, 0x3D])
    #expect([UInt8](frame) == [0x81, 0x85, 0x37, 0xFA, 0x21, 0x3D, 0x7F, 0x9F, 0x4D, 0x51, 0x58])
    let long = WebSocketFraming.frame(.text, Data(repeating: 0, count: 70_000), mask: [0, 0, 0, 0])
    #expect([UInt8](long.prefix(10)) == [0x81, 0xFF, 0, 0, 0, 0, 0, 0x01, 0x11, 0x70])
  }

  @Test func acceptsOnlyASwitchingProtocolsAnswerWithTheKeysAcceptValue() throws {
    let key = "dGhlIHNhbXBsZSBub25jZQ=="
    let answer = Data(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n"
        .utf8)
    #expect(try WebSocketFraming.readUpgrade(answer.prefix(20), key: key) == nil)
    #expect(try WebSocketFraming.readUpgrade(answer + Data([0x81, 0x00]), key: key) == Data([0x81, 0x00]))
    #expect(throws: WebSocketFraming.Failure.self) {
      try WebSocketFraming.readUpgrade(answer, key: "AAAAAAAAAAAAAAAAAAAAAA==")
    }
    #expect(throws: WebSocketFraming.Failure(message: "stim-server is not ready yet.")) {
      try WebSocketFraming.readUpgrade(
        Data("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".utf8), key: key)
    }
  }

  @Test func readsMessagesSplitAcrossReadsAndFragmentsAroundAPing() throws {
    var reader = WebSocketFraming.Reader(maximumMessageSize: 1 << 20)
    let keyframe = Data((0..<70_000).map { UInt8($0 & 0xFF) })
    let stream =
      serverFrame(0x02, keyframe.prefix(40_000)) + serverFrame(0x89, Data("p".utf8))
      + serverFrame(0x80, keyframe.suffix(30_000)) + serverFrame(0x81, Data(#"{"id":1}"#.utf8))
    var frames: [WebSocketFraming.Frame] = []
    var offset = 0
    while offset < stream.count {
      let end = min(offset + 4_096, stream.count)
      frames += try reader.read(stream.subdata(in: offset..<end))
      offset = end
    }
    #expect(
      frames == [
        .init(opcode: .ping, payload: Data("p".utf8)), .init(opcode: .binary, payload: keyframe),
        .init(opcode: .text, payload: Data(#"{"id":1}"#.utf8)),
      ])
  }

  @Test func refusesAMessageOverTheLimitEvenWhenFragmented() {
    var whole = WebSocketFraming.Reader(maximumMessageSize: 100)
    #expect(throws: WebSocketFraming.Failure.self) { try whole.read(serverFrame(0x82, Data(count: 101))) }
    var pieces = WebSocketFraming.Reader(maximumMessageSize: 100)
    #expect(throws: WebSocketFraming.Failure.self) {
      try pieces.read(serverFrame(0x02, Data(count: 60)) + serverFrame(0x80, Data(count: 41)))
    }
  }
}
