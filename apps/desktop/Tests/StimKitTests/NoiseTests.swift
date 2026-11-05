import CryptoKit
import Foundation
import Testing

@testable import StimKit

/// Desktop's Noise client must produce the bytes core's `noise.ts` and `noise-session.ts` do, so it is checked against
/// core's own fixtures rather than copies.
@Suite struct NoiseTests {
  static let fixtures = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().appendingPathComponent("packages/core/__tests__/fixtures")

  struct Vector: Decodable {
    struct Message: Decodable {
      var payload: String
      var ciphertext: String
    }

    var source: String
    var protocolName: String
    var initPrologue: String
    var initStatic: String
    var initEphemeral: String
    var initPsks: [String]?
    var handshakeHash: String?
    var messages: [Message]
  }

  struct FramingVector: Decodable {
    var key: String
    var counter: String
    var type: String
    var data: String
    var ciphertext: String
  }

  struct SecretVectors: Decodable {
    struct Secret: Decodable {
      var secret: String
      var psk: String
      var lookup: String
    }

    struct Fingerprint: Decodable {
      var publicKey: String
      var fingerprint: String
    }

    var secrets: [Secret]
    var fingerprint: Fingerprint
  }

  struct List<Item: Decodable>: Decodable { var vectors: [Item] }

  static func load<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return try decoder.decode(T.self, from: Data(contentsOf: fixtures.appendingPathComponent(name)))
  }

  static func hex(_ text: String) -> Data {
    var data = Data()
    var index = text.startIndex
    while index < text.endIndex {
      let next = text.index(index, offsetBy: 2)
      data.append(UInt8(text[index..<next], radix: 16)!)
      index = next
    }
    return data
  }

  static func hexString(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

  static func key(_ text: String) throws -> Curve25519.KeyAgreement.PrivateKey {
    try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(text))
  }

  @Test func theInitiatorReproducesEveryHandshakeAndTransportMessageOfCoresVectors() throws {
    let vectors = try Self.load("noise-vectors.json", as: List<Vector>.self).vectors
    #expect(vectors.count > 10)
    for (index, vector) in vectors.enumerated() {
      let name = "\(vector.source) \(vector.protocolName) #\(index)"
      #expect(vector.protocolName == (vector.initPsks == nil ? Noise.xx : Noise.xxPsk2), "\(name)")
      var handshake = NoiseHandshake(
        psk: vector.initPsks?.first.map(Self.hex), prologue: Self.hex(vector.initPrologue),
        staticKey: try Self.key(vector.initStatic), ephemeralKey: try Self.key(vector.initEphemeral))
      let messages = vector.messages
      #expect(Self.hexString(try handshake.writeMessage(Self.hex(messages[0].payload))) == messages[0].ciphertext, "\(name)")
      #expect(Self.hexString(try handshake.readMessage(Self.hex(messages[1].ciphertext))) == messages[1].payload, "\(name)")
      #expect(Self.hexString(try handshake.writeMessage(Self.hex(messages[2].payload))) == messages[2].ciphertext, "\(name)")
      if let hash = vector.handshakeHash { #expect(Self.hexString(handshake.handshakeHash) == hash, "\(name)") }
      var (send, receive) = try handshake.split()
      for (offset, message) in messages.dropFirst(3).enumerated() {
        if offset % 2 == 0 {
          #expect(Self.hexString(try receive.decrypt(ad: Data(), Self.hex(message.ciphertext))) == message.payload, "\(name)")
        } else {
          #expect(Self.hexString(try send.encrypt(ad: Data(), Self.hex(message.payload))) == message.ciphertext, "\(name)")
        }
      }
    }
  }

  @Test func theTransportFramingMatchesCoresVectorsAtEveryCounter() throws {
    for vector in try Self.load("noise-framing-vectors.json", as: List<FramingVector>.self).vectors {
      let counter = try #require(UInt64(vector.counter))
      func cipher() -> NoiseCipherState {
        var state = NoiseCipherState(key: Self.hex(vector.key))
        state.setNonce(counter)
        return state
      }
      var transport = NoiseTransportCipher(send: cipher(), receive: cipher())
      let data = Self.hex(vector.data)
      let message: NoiseTransportCipher.Message =
        vector.type == "text" ? .text(String(decoding: data, as: UTF8.self)) : .binary(data)
      #expect(Self.hexString(try transport.encrypt(message)) == vector.ciphertext, "counter \(vector.counter)")
      #expect(try transport.decrypt(Self.hex(vector.ciphertext)) == message, "counter \(vector.counter)")
    }
  }

  @Test func aPairingTokenDerivesCoresPskLookupAndFingerprint() throws {
    let vectors = try Self.load("noise-secret-vectors.json", as: SecretVectors.self)
    for vector in vectors.secrets {
      let secret = try #require(Noise.decodeSecret(vector.secret))
      let values = Noise.secretValues(secret)
      #expect(Self.hexString(values.psk) == vector.psk)
      #expect(Self.hexString(values.lookup) == vector.lookup)
    }
    #expect(Noise.fingerprint(Self.hex(vectors.fingerprint.publicKey)) == vectors.fingerprint.fingerprint)
    #expect(Noise.decodeSecret("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh9") == nil)
    #expect(Noise.decodeSecret("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh+") == nil)
  }

  /// CryptoKit does not refuse a low-order point, so the client checks the all-zero shared secret itself.
  @Test func aServerEphemeralKeyOfAllZerosFailsTheHandshake() throws {
    var handshake = NoiseHandshake(psk: nil, prologue: Data(), staticKey: .init())
    _ = try handshake.writeMessage()
    #expect(throws: Noise.Failure.self) { try handshake.readMessage(Data(count: 96)) }
    #expect(throws: Noise.Failure.self) { try handshake.writeMessage() }
    #expect(handshake.remoteStaticKey == nil)
  }

  @Test func aTamperedTruncatedOrMistypedServerMessageClosesTheTransport() throws {
    let key = Data(repeating: 7, count: 32)
    func pair() -> (server: NoiseCipherState, client: NoiseTransportCipher) {
      (NoiseCipherState(key: key), NoiseTransportCipher(send: NoiseCipherState(key: key), receive: NoiseCipherState(key: key)))
    }
    var (server, client) = pair()
    var sealed = try server.encrypt(ad: Data(), Data([0x01]) + Data("{}".utf8))
    sealed[sealed.count - 1] ^= 1
    #expect(throws: Noise.Failure.self) { try client.decrypt(sealed) }
    #expect(client.closed)
    #expect(throws: Noise.Failure.self) { try client.encrypt(.text("after")) }

    for plaintext in [Data([0x03, 0x41]), Data([0x01, 0xFF]), Data()] {
      (server, client) = pair()
      #expect(throws: Noise.Failure.self) { try client.decrypt(try server.encrypt(ad: Data(), plaintext)) }
      #expect(client.closed)
    }

    (server, client) = pair()
    #expect(throws: Noise.Failure.self) { try client.decrypt(Data(count: 15)) }
    #expect(client.closed)
  }

  @Test func theTransportCapsWhatItSendsAndReceives() throws {
    let key = Data(repeating: 9, count: 32)
    var client = NoiseTransportCipher(send: NoiseCipherState(key: key), receive: NoiseCipherState(key: key))
    #expect(throws: Noise.Failure.self) { try client.encrypt(.binary(Data(count: Noise.maximumClientMessageBytes + 1))) }
    var server = NoiseCipherState(key: key)
    var receiver = NoiseTransportCipher(send: NoiseCipherState(key: key), receive: NoiseCipherState(key: key))
    let largest = Data([0x02]) + Data(count: Noise.maximumServerMessageBytes)
    #expect(
      try receiver.decrypt(try server.encrypt(ad: Data(), largest)) == .binary(Data(count: Noise.maximumServerMessageBytes)))
    #expect(throws: Noise.Failure.self) { try receiver.decrypt(try server.encrypt(ad: Data(), largest + Data([0]))) }
  }

  @Test func aCounterNeverUsesTheReservedNonce() throws {
    var cipher = NoiseCipherState(key: Data(repeating: 1, count: 32))
    cipher.setNonce(UInt64.max - 1)
    _ = try cipher.encrypt(ad: Data(), Data("last".utf8))
    #expect(throws: Noise.Failure.self) { try cipher.encrypt(ad: Data(), Data("wrapped".utf8)) }
  }
}
