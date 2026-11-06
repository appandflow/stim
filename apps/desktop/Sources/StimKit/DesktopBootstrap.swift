import CryptoKit
import Darwin
import Foundation

/// The private key stimd writes to `$STIM_HOME/run/desktop.key` (mode 0600) for Stim Desktop. Desktop only reads it
/// and proves it with HMACs; the key itself is never sent, logged or passed to another process.
public struct DesktopBootstrapKey: Sendable {
  let key: SymmetricKey

  /// The 43-character base64url form of 32 random bytes.
  public init?(encoded: String) {
    guard let data = Data(base64URL: encoded.trimmingCharacters(in: .whitespacesAndNewlines)), data.count == 32 else {
      return nil
    }
    key = SymmetricKey(data: data)
  }

  /// The key file of `stimHome`, or nil when it is missing, not a regular file this user owns, readable by anyone
  /// else, or not a key.
  public static func read(stimHome: String) -> DesktopBootstrapKey? {
    let path = "\(EngineFiles.runDirectory(stimHome: stimHome))/desktop.key"
    let descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else { return nil }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    var info = stat()
    guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(),
      info.st_mode & 0o077 == 0, let data = try? handle.read(upToCount: 128)
    else { return nil }
    return DesktopBootstrapKey(encoded: String(decoding: data, as: UTF8.self))
  }

  /// Verify the server and prove this connection with the separate `server:` and `client:` HMAC domains.
  public func clientProof(for challenge: DesktopBootstrapChallenge) -> String? {
    guard let nonce = Data(base64URL: challenge.nonce), nonce.count == 32,
      let proof = Data(base64URL: challenge.proof), proof.count == 32,
      HMAC<SHA256>.isValidAuthenticationCode(proof, authenticating: Data("server:\(challenge.nonce)".utf8), using: key)
    else { return nil }
    return Data(HMAC<SHA256>.authenticationCode(for: Data("client:\(challenge.nonce)".utf8), using: key)).base64URL
  }
}

public struct DesktopBootstrapChallenge: Decodable, Equatable, Sendable {
  public var nonce: String
  public var proof: String
}

extension Data {
  fileprivate var base64URL: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  fileprivate init?(base64URL: String) {
    guard base64URL.count == 43 else { return nil }
    self.init(base64Encoded: base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "=")
  }
}
