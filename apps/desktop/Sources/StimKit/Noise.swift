import CryptoKit
import Foundation

/// The client side of stim-server's protocol 2 authentication, as `packages/core/noise.ts` and
/// `packages/core/noise-session.ts` define it: a `Noise_XX_25519_ChaChaPoly_SHA256` or
/// `Noise_XXpsk2_25519_ChaChaPoly_SHA256` initiator, then Stim's transport framing.
public enum Noise {
  /// The protocol version byte that opens every protocol 2 connection.
  static let protocolVersion: UInt8 = 2
  static let modeReturning: UInt8 = 0
  static let modeFirstContact: UInt8 = 1
  static let keyBytes = 32
  static let tagBytes = 16
  static let lookupBytes = 16
  static let maximumHandshakeMessageBytes = 1024
  /// Largest message, plaintext without its type byte, a server accepts from a client.
  static let maximumClientMessageBytes = 64 * 1024
  /// Largest message, plaintext without its type byte, a server sends.
  static let maximumServerMessageBytes = 16 * 1024 * 1024
  /// What a transport message adds to its plaintext on the wire: the type byte and the ChaCha20-Poly1305 tag.
  static let transportOverheadBytes = 17

  static let xx = "Noise_XX_25519_ChaChaPoly_SHA256"
  static let xxPsk2 = "Noise_XXpsk2_25519_ChaChaPoly_SHA256"

  /// Any handshake or transport failure; the handshake or transport is unusable afterwards.
  public struct Failure: Error, Equatable, LocalizedError {
    public var message: String
    public var errorDescription: String? { message }
  }

  /// The values a pairing token's 32 bytes derive: the PSK and the lookup the cleartext prefix carries.
  struct SecretValues: Equatable {
    var psk: Data
    var lookup: Data
  }

  /// The 32 bytes of a pairing token, or nil when `text` is not 43 base64url characters that encode exactly them.
  public static func decodeSecret(_ text: String) -> Data? {
    guard text.utf8.count == 43, text.utf8.allSatisfy(isBase64URL), let bytes = base64URLDecode(text),
      bytes.count == keyBytes, base64URLEncode(bytes) == text
    else { return nil }
    return bytes
  }

  static func secretValues(_ secret: Data) -> SecretValues {
    SecretValues(
      psk: sha256(Data("stim noise psk v1".utf8) + secret),
      lookup: Data(sha256(Data("stim noise lookup v1".utf8) + secret).prefix(lookupBytes)))
  }

  /// A server key's fingerprint, as the pairing payload carries it: base64url of the key's SHA-256.
  public static func fingerprint(_ publicKey: Data) -> String { base64URLEncode(sha256(publicKey)) }

  /// The cleartext prefix of the first WebSocket message: version, mode, and for first contact the secret's lookup.
  static func prefix(lookup: Data?) -> Data {
    Data([protocolVersion, lookup == nil ? modeReturning : modeFirstContact]) + (lookup ?? Data())
  }

  /// `"stim noise v1" || prefix`, so the handshake authenticates the version, mode and lookup.
  static func prologue(prefix: Data) -> Data { Data("stim noise v1".utf8) + prefix }

  static func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

  static func hmac(_ key: Data, _ data: Data) -> Data {
    Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
  }

  /// Noise revision 34, section 4.3: HKDF as chained HMAC-SHA256, three outputs.
  static func hkdf(_ chainingKey: Data, _ input: Data) -> (Data, Data, Data) {
    let temp = hmac(chainingKey, input)
    let first = hmac(temp, Data([1]))
    let second = hmac(temp, first + Data([2]))
    return (first, second, hmac(temp, second + Data([3])))
  }

  /// X25519, refusing the all-zero shared secret a low-order peer key produces; CryptoKit does not refuse it.
  static func dh(_ privateKey: Curve25519.KeyAgreement.PrivateKey, _ publicKey: Data) throws -> Data {
    let shared: Data
    do {
      let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKey)
      shared = try privateKey.sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) }
    } catch {
      throw Failure(message: "X25519 failed; the peer sent an invalid public key.")
    }
    guard shared.reduce(0, { $0 | $1 }) != 0 else {
      throw Failure(message: "X25519 failed; the peer sent an invalid public key.")
    }
    return shared
  }

  private static func isBase64URL(_ byte: UInt8) -> Bool {
    (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A) || (byte >= 0x30 && byte <= 0x39) || byte == 0x2D
      || byte == 0x5F
  }

  static func base64URLEncode(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func base64URLDecode(_ text: String) -> Data? {
    var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    return Data(base64Encoded: base64)
  }
}

/// Noise's CipherState: a ChaCha20-Poly1305 key and a 64-bit counter used as the nonce.
struct NoiseCipherState {
  private let key: SymmetricKey?
  private(set) var nonce: UInt64 = 0

  init(key: Data?) {
    self.key = key.map { SymmetricKey(data: $0) }
  }

  var hasKey: Bool { key != nil }

  mutating func setNonce(_ nonce: UInt64) { self.nonce = nonce }

  /// Noise revision 34, section 12.3: 32 zero bits, then the counter as 64 bits little-endian.
  private func chachaNonce() throws -> ChaChaPoly.Nonce {
    // Noise revision 34, section 5.1: nonce 2^64-1 is reserved and never encrypts or decrypts a message.
    guard nonce < UInt64.max else { throw Noise.Failure(message: "Nonce exhausted.") }
    return try ChaChaPoly.Nonce(data: Data(count: 4) + withUnsafeBytes(of: nonce.littleEndian) { Data($0) })
  }

  mutating func encrypt(ad: Data, _ plaintext: Data) throws -> Data {
    guard let key else { return plaintext }
    let box = try ChaChaPoly.seal(plaintext, using: key, nonce: try chachaNonce(), authenticating: ad)
    nonce += 1
    return box.ciphertext + box.tag
  }

  /// Splits the wire's ciphertext and tag itself: Stim's wire format carries no nonce, so the combined form never
  /// applies.
  mutating func decrypt(ad: Data, _ ciphertext: Data) throws -> Data {
    guard let key else { return ciphertext }
    guard ciphertext.count >= Noise.tagBytes else {
      throw Noise.Failure(message: "Message is shorter than its authentication tag.")
    }
    let body = Data(ciphertext.prefix(ciphertext.count - Noise.tagBytes))
    let tag = Data(ciphertext.suffix(Noise.tagBytes))
    let plaintext: Data
    do {
      let box = try ChaChaPoly.SealedBox(nonce: try chachaNonce(), ciphertext: body, tag: tag)
      plaintext = try ChaChaPoly.open(box, using: key, authenticating: ad)
    } catch let failure as Noise.Failure {
      throw failure
    } catch {
      throw Noise.Failure(message: "Message failed authentication.")
    }
    nonce += 1
    return plaintext
  }
}

private struct NoiseSymmetricState {
  private var chainingKey: Data
  private(set) var hash: Data
  private(set) var cipher = NoiseCipherState(key: nil)

  init(protocolName: String) {
    let name = Data(protocolName.utf8)
    // Noise revision 34, section 5.2: a name of at most HASHLEN bytes is zero-padded, a longer one hashed.
    hash = name.count <= 32 ? name + Data(count: 32 - name.count) : Noise.sha256(name)
    chainingKey = hash
  }

  mutating func mixHash(_ data: Data) { hash = Noise.sha256(hash + data) }

  mutating func mixKey(_ input: Data) {
    let (chaining, key, _) = Noise.hkdf(chainingKey, input)
    chainingKey = chaining
    cipher = NoiseCipherState(key: key)
  }

  mutating func mixKeyAndHash(_ input: Data) {
    let (chaining, mixed, key) = Noise.hkdf(chainingKey, input)
    chainingKey = chaining
    mixHash(mixed)
    cipher = NoiseCipherState(key: key)
  }

  mutating func encryptAndHash(_ plaintext: Data) throws -> Data {
    let ciphertext = try cipher.encrypt(ad: hash, plaintext)
    mixHash(ciphertext)
    return ciphertext
  }

  mutating func decryptAndHash(_ ciphertext: Data) throws -> Data {
    let plaintext = try cipher.decrypt(ad: hash, ciphertext)
    mixHash(ciphertext)
    return plaintext
  }

  func split() -> (NoiseCipherState, NoiseCipherState) {
    let (first, second, _) = Noise.hkdf(chainingKey, Data())
    return (NoiseCipherState(key: first), NoiseCipherState(key: second))
  }
}

/// The initiator of `Noise_XX` (no PSK) or `Noise_XXpsk2`: it writes messages 1 and 3 and reads message 2. Any error,
/// including an out-of-turn call or an oversized message, ends the handshake: every later call throws.
struct NoiseHandshake {
  private var symmetric: NoiseSymmetricState
  private let staticKey: Curve25519.KeyAgreement.PrivateKey
  private var ephemeralKey: Curve25519.KeyAgreement.PrivateKey?
  private let psk: Data?
  private var remoteEphemeral: Data?
  private var index = 0
  private var failed = false
  /// The server's static public key, once message 2 carrying it has been read and authenticated.
  private(set) var remoteStaticKey: Data?

  /// `ephemeralKey` is fixed only to reproduce published test vectors.
  init(
    psk: Data?, prologue: Data, staticKey: Curve25519.KeyAgreement.PrivateKey,
    ephemeralKey: Curve25519.KeyAgreement.PrivateKey? = nil
  ) {
    symmetric = NoiseSymmetricState(protocolName: psk == nil ? Noise.xx : Noise.xxPsk2)
    symmetric.mixHash(prologue)
    self.staticKey = staticKey
    self.ephemeralKey = ephemeralKey
    self.psk = psk
  }

  var isComplete: Bool { index == 3 && !failed }

  var handshakeHash: Data { symmetric.hash }

  /// Message 1 (`e`) or message 3 (`s, se`).
  mutating func writeMessage(_ payload: Data = Data()) throws -> Data {
    try step(expecting: [0, 2]) { state in
      var message = Data()
      if state.index == 0 {
        let ephemeral = state.ephemeralKey ?? Curve25519.KeyAgreement.PrivateKey()
        state.ephemeralKey = ephemeral
        message += ephemeral.publicKey.rawRepresentation
        state.mixEphemeral(ephemeral.publicKey.rawRepresentation)
      } else {
        guard let remoteEphemeral = state.remoteEphemeral else { throw Noise.Failure(message: "The handshake is missing a key.") }
        message += try state.symmetric.encryptAndHash(state.staticKey.publicKey.rawRepresentation)
        state.symmetric.mixKey(try Noise.dh(state.staticKey, remoteEphemeral))
      }
      message += try state.symmetric.encryptAndHash(payload)
      guard message.count <= Noise.maximumHandshakeMessageBytes else {
        throw Noise.Failure(message: "Handshake message is too large.")
      }
      return message
    }
  }

  /// Message 2: `e, ee, s, es`, then `psk` for `Noise_XXpsk2`. Returns its payload.
  mutating func readMessage(_ message: Data) throws -> Data {
    try step(expecting: [1]) { state in
      guard message.count <= Noise.maximumHandshakeMessageBytes else {
        throw Noise.Failure(message: "Handshake message is too large.")
      }
      let bytes = Data(message)
      let staticLength = Noise.keyBytes + Noise.tagBytes
      guard bytes.count >= Noise.keyBytes + staticLength, let ephemeralKey = state.ephemeralKey else {
        throw Noise.Failure(message: "Handshake message is truncated.")
      }
      let remoteEphemeral = Data(bytes.prefix(Noise.keyBytes))
      state.remoteEphemeral = remoteEphemeral
      state.mixEphemeral(remoteEphemeral)
      state.symmetric.mixKey(try Noise.dh(ephemeralKey, remoteEphemeral))
      let remoteStatic = try state.symmetric.decryptAndHash(Data(bytes[Noise.keyBytes..<(Noise.keyBytes + staticLength)]))
      state.symmetric.mixKey(try Noise.dh(ephemeralKey, remoteStatic))
      if let psk = state.psk { state.symmetric.mixKeyAndHash(psk) }
      let payload = try state.symmetric.decryptAndHash(Data(bytes.dropFirst(Noise.keyBytes + staticLength)))
      state.remoteStaticKey = remoteStatic
      return payload
    }
  }

  /// Noise's Split(): this initiator's sending and receiving cipher states.
  func split() throws -> (send: NoiseCipherState, receive: NoiseCipherState) {
    guard isComplete else { throw Noise.Failure(message: "The handshake is not complete.") }
    let (initiatorToResponder, responderToInitiator) = symmetric.split()
    return (initiatorToResponder, responderToInitiator)
  }

  private mutating func step(expecting turns: Set<Int>, _ run: (inout NoiseHandshake) throws -> Data) throws -> Data {
    guard !failed else { throw Noise.Failure(message: "The handshake has failed.") }
    do {
      guard turns.contains(index) else { throw Noise.Failure(message: "It is not this side's turn.") }
      let result = try run(&self)
      index += 1
      return result
    } catch {
      failed = true
      remoteStaticKey = nil
      throw error as? Noise.Failure ?? Noise.Failure(message: "The handshake failed.")
    }
  }

  private mutating func mixEphemeral(_ publicKey: Data) {
    symmetric.mixHash(publicKey)
    // Noise revision 34, section 9.2: in a PSK handshake every "e" token also calls MixKey(e.public_key).
    if psk != nil { symmetric.mixKey(publicKey) }
  }
}

/// Stim's framing after the handshake: each WebSocket message is one ChaCha20-Poly1305 message with empty associated
/// data under the next counter, whose first plaintext byte is the type, 0x01 text or 0x02 binary. Counters are not
/// sent, so a reordered, replayed, dropped or altered message fails to decrypt. Any failure closes the transport.
struct NoiseTransportCipher {
  enum Message: Equatable {
    case text(String)
    case binary(Data)
  }

  private var send: NoiseCipherState
  private var receive: NoiseCipherState
  let maximumSendBytes: Int
  let maximumReceiveBytes: Int
  private(set) var closed = false

  init(
    send: NoiseCipherState, receive: NoiseCipherState, maximumSendBytes: Int = Noise.maximumClientMessageBytes,
    maximumReceiveBytes: Int = Noise.maximumServerMessageBytes
  ) {
    self.send = send
    self.receive = receive
    self.maximumSendBytes = maximumSendBytes
    self.maximumReceiveBytes = maximumReceiveBytes
  }

  mutating func encrypt(_ message: Message) throws -> Data {
    guard !closed else { throw Noise.Failure(message: "The transport is closed.") }
    let (type, body): (UInt8, Data)
    switch message {
    case .text(let text): (type, body) = (0x01, Data(text.utf8))
    case .binary(let data): (type, body) = (0x02, data)
    }
    do {
      guard body.count <= maximumSendBytes else {
        throw Noise.Failure(message: "Message exceeds \(maximumSendBytes) bytes.")
      }
      return try send.encrypt(ad: Data(), Data([type]) + body)
    } catch {
      closed = true
      throw error
    }
  }

  mutating func decrypt(_ message: Data) throws -> Message {
    guard !closed else { throw Noise.Failure(message: "The transport is closed.") }
    do {
      guard message.count <= maximumReceiveBytes + Noise.transportOverheadBytes else {
        throw Noise.Failure(message: "Message is too large.")
      }
      let plaintext = try receive.decrypt(ad: Data(), Data(message))
      let body = Data(plaintext.dropFirst())
      switch plaintext.first {
      case 0x01:
        let text = String(decoding: body, as: UTF8.self)
        guard Data(text.utf8) == body else { throw Noise.Failure(message: "Text message is not valid UTF-8.") }
        return .text(text)
      case 0x02: return .binary(body)
      default: throw Noise.Failure(message: "Unknown message type.")
      }
    } catch {
      closed = true
      throw error as? Noise.Failure ?? Noise.Failure(message: "Message is not valid.")
    }
  }
}
