import CryptoKit
import Foundation

/// The private key passed only to the bundled child through its input pipe.
public struct DesktopBootstrapKey: Sendable {
  private let key = SymmetricKey(size: .bits256)

  public init() {}

  public var input: Data {
    key.withUnsafeBytes { Data((Data($0).base64URL + "\n").utf8) }
  }

  /// Verify the child and prove this connection with the separate `server:` and `client:` HMAC domains.
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
