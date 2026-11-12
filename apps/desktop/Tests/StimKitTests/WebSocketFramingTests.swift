import Foundation
import Network
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

  @Test func takesAPingBetweenFragmentsAtTheSizeLimit() throws {
    var reader = WebSocketFraming.Reader(maximumMessageSize: 100)
    let frames = try reader.read(
      serverFrame(0x02, Data(count: 100)) + serverFrame(0x89, Data("p".utf8)) + serverFrame(0x80, Data()))
    #expect(frames == [.init(opcode: .ping, payload: Data("p".utf8)), .init(opcode: .binary, payload: Data(count: 100))])
  }

  @Test func refusesAFragmentedOrOversizedControlFrame() {
    var fragmented = WebSocketFraming.Reader(maximumMessageSize: 1 << 20)
    #expect(throws: WebSocketFraming.Failure.self) { try fragmented.read(serverFrame(0x09, Data("p".utf8))) }
    var oversized = WebSocketFraming.Reader(maximumMessageSize: 1 << 20)
    #expect(throws: WebSocketFraming.Failure.self) { try oversized.read(serverFrame(0x89, Data(count: 126))) }
  }

  @Test func readsManyFragmentsOfOneMessage() throws {
    var reader = WebSocketFraming.Reader(maximumMessageSize: 1 << 20)
    var stream = serverFrame(0x02, Data([0]))
    for _ in 0..<20_000 { stream += serverFrame(0x00, Data([1])) }
    stream += serverFrame(0x80, Data([2]))
    let frames = try reader.read(stream)
    #expect(frames.count == 1)
    #expect(frames.first?.payload.count == 20_002)
  }

  @Test func refusesASwitchingProtocolsAnswerWithoutTheWebSocketUpgrade() {
    let key = "dGhlIHNhbXBsZSBub25jZQ=="
    let answer = Data(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: h2c\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n"
        .utf8)
    #expect(throws: WebSocketFraming.Failure.self) { try WebSocketFraming.readUpgrade(answer, key: key) }
  }
}

/// A WebSocket server on loopback that completes the upgrade, then either answers every frame with a pong or stays
/// silent, as a peer behind a dropped route does.
@MainActor private final class PingPeer {
  private let listener: NWListener
  private var connections: [NWConnection] = []
  private let answers: Bool

  init(answers: Bool) throws {
    self.answers = answers
    listener = try NWListener(using: .tcp, on: .any)
    listener.newConnectionHandler = { [weak self] connection in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.connections.append(connection)
        connection.start(queue: .main)
        self.read(connection, head: Data())
      }
    }
    listener.start(queue: .main)
  }

  func port() async -> UInt16? {
    for _ in 0..<200 {
      if let port = listener.port?.rawValue, port != 0 { return port }
      try? await Task.sleep(for: .milliseconds(10))
    }
    return nil
  }

  func stop() {
    listener.cancel()
    for connection in connections { connection.cancel() }
  }

  private func read(_ connection: NWConnection, head: Data?) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, error in
      MainActor.assumeIsolated {
        guard let self, let data, error == nil, !done else { return }
        guard var head else {
          if self.answers { connection.send(content: Data([0x8A, 0x00]), completion: .idempotent) }
          return self.read(connection, head: nil)
        }
        head.append(data)
        let text = String(decoding: head, as: UTF8.self)
        guard text.contains("\r\n\r\n") else { return self.read(connection, head: head) }
        let key =
          text.components(separatedBy: "\r\n").first { $0.lowercased().hasPrefix("sec-websocket-key:") }
          .map { $0.dropFirst("sec-websocket-key:".count).trimmingCharacters(in: .whitespaces) } ?? ""
        let answer =
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
          + "Sec-WebSocket-Accept: \(WebSocketFraming.accept(for: key))\r\n\r\n"
        connection.send(content: Data(answer.utf8), completion: .idempotent)
        self.read(connection, head: nil)
      }
    }
  }
}

@MainActor struct WebSocketKeepaliveTests {
  private func connect(to peer: PingPeer, events: @escaping @MainActor (WebSocketStream.Event) -> Void) async throws
    -> WebSocketStream
  {
    let port = try #require(await peer.port())
    return WebSocketStream(
      to: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!), using: .tcp, host: "127.0.0.1",
      path: "/", maximumMessageSize: 1024, keepalive: 0.1, onEvent: events)
  }

  @Test func aPeerThatStopsAnsweringEndsTheConnection() async throws {
    let peer = try PingPeer(answers: false)
    defer { peer.stop() }
    var closed: String?
    let stream = try await connect(to: peer) { if case .closed(let description, _, _) = $0 { closed = description } }
    defer { stream.close() }
    for _ in 0..<200 where closed == nil { try await Task.sleep(for: .milliseconds(10)) }
    #expect(closed == "The machine stopped answering.")
  }

  @Test func aPeerThatAnswersPingsStaysConnected() async throws {
    let peer = try PingPeer(answers: true)
    defer { peer.stop() }
    var closed: String?
    let stream = try await connect(to: peer) { if case .closed(let description, _, _) = $0 { closed = description } }
    defer { stream.close() }
    try await Task.sleep(for: .milliseconds(800))
    #expect(closed == nil)
  }
}

/// A stimd CLI socket on loopback TCP that answers each prelude line with the next scripted reply and records the lines
/// and upgrade request it receives.
@MainActor private final class StimdPeer {
  private let listener: NWListener
  private var connections: [NWConnection] = []
  private var replies: [String]
  private(set) var received = ""

  init(replies: [String]) throws {
    self.replies = replies
    listener = try NWListener(using: .tcp, on: .any)
    listener.newConnectionHandler = { [weak self] connection in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.connections.append(connection)
        connection.start(queue: .main)
        self.read(connection)
      }
    }
    listener.start(queue: .main)
  }

  func port() async -> UInt16? {
    for _ in 0..<200 {
      if let port = listener.port?.rawValue, port != 0 { return port }
      try? await Task.sleep(for: .milliseconds(10))
    }
    return nil
  }

  func stop() {
    listener.cancel()
    for connection in connections { connection.cancel() }
  }

  private func read(_ connection: NWConnection) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, error in
      MainActor.assumeIsolated {
        guard let self, let data, error == nil, !done else { return }
        self.received += String(decoding: data, as: UTF8.self)
        if !self.replies.isEmpty, data.last == 10 {
          connection.send(content: Data((self.replies.removeFirst() + "\n").utf8), completion: .idempotent)
        }
        self.read(connection)
      }
    }
  }
}

@MainActor struct StimdPreludeTests {
  private func run(_ replies: [String]) async throws -> (StimdPeer, [WebSocketStream.Event], Int?) {
    let peer = try StimdPeer(replies: replies)
    let port = try #require(await peer.port())
    var events: [WebSocketStream.Event] = []
    var listening: Int?
    let stream = WebSocketStream(
      to: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!), using: .tcp, host: "localhost",
      path: "/", maximumMessageSize: 1024,
      prelude: UnixSocketTransport.stimdPrelude(loopbackOnly: true, port: 0) { listening = $0 }
    ) { events.append($0) }
    for _ in 0..<100 where events.isEmpty && !peer.received.contains("\r\n\r\n") {
      try await Task.sleep(for: .milliseconds(10))
    }
    stream.close()
    peer.stop()
    return (peer, events, listening)
  }

  @Test func declaresDesktopStartsTheListenerAndUpgradesOnlyAfterStimdHandsTheConnectionOver() async throws {
    let (peer, events, listening) = try await run([
      #"{"op":"hello","kind":"stimd","pid":1,"build":"3f9a1c0d22e8","version":"1.43.0"}"#,
      #"{"op":"net","listening":true,"port":7801}"#, #"{"op":"net.connected"}"#,
    ])
    let lines = peer.received.split(separator: "\n", maxSplits: 3).map(String.init)
    #expect(
      lines.prefix(3) == [
        #"{"kind":"desktop"}"#, #"{"op":"net.ensure","params":{"loopbackOnly":true,"port":0}}"#, #"{"op":"net.connect"}"#,
      ])
    #expect(lines.count == 4 && lines[3].hasPrefix("GET / HTTP/1.1"))
    #expect(listening == 7801)
    #expect(events.isEmpty)
  }

  @Test func aListenerStimdCannotStartRefusesWithItsTextBeforeTheUpgrade() async throws {
    let refusal = "port 7787 is held by pid 42; stop it (kill 42), or run stim serve --port <n>."
    let (peer, events, listening) = try await run([
      #"{"op":"hello","kind":"stimd","pid":1,"build":"3f9a1c0d22e8","version":"1.43.0"}"#,
      #"{"op":"net","listening":false,"message":"\#(refusal)"}"#,
    ])
    #expect(!peer.received.contains("net.connect") && !peer.received.contains("GET /"))
    #expect(listening == nil)
    guard case .refused(let text)? = events.first else {
      Issue.record("expected a refusal, got \(events)")
      return
    }
    #expect(text == refusal)
  }
}
