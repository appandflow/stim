import Foundation

/// A checked `stim-server pair` payload: a tailnet endpoint, the single-use token's 32 bytes and the server key's
/// fingerprint, which Desktop always requires.
public struct PairingPayload: Equatable, Sendable {
  public enum Problem: Error, Equatable, LocalizedError {
    case notAPairingCode
    case serverOutdated
    case desktopOutdated
    case missingFingerprint
    case badToken
    case notTailnet

    public var errorDescription: String? {
      switch self {
      case .notAPairingCode: return "This is not a Stim pairing code. Paste the output of stim-server pair."
      case .serverOutdated: return "This pairing code is from an older stim-server. Update stim-server on that machine."
      case .desktopOutdated: return "This pairing code needs a newer Stim Desktop."
      case .missingFingerprint: return "The pairing code has no server fingerprint, so Stim Desktop cannot check the server."
      case .badToken: return "The pairing token or fingerprint is not 43 letters, digits, - and _."
      case .notTailnet:
        return
          "The endpoint must be wss:// to a .ts.net name, or ws:// to a Tailscale IP address (100.64.0.0/10 or fd7a:115c:a1e0::/48)."
      }
    }
  }

  public var name: String
  public var endpoint: URL
  public var secret: Data
  public var fingerprint: String

  /// Reads the bare JSON `stim-server pair` prints or the `{ qr, expiresAt }` wrapper of `pair --json`.
  public static func parse(_ text: String) throws -> PairingPayload {
    let data = Data(text.utf8)
    guard case .object(let outer)? = try? JSONDecoder().decode(JSONValue.self, from: data) else {
      throw Problem.notAPairingCode
    }
    let wrapped = outer["qr"] != nil
    guard case .object(let fields)? = wrapped ? outer["qr"] : .object(outer) else { throw Problem.notAPairingCode }
    switch fields["v"]?.number {
    case 2?: break
    case 1?: throw Problem.serverOutdated
    case let version? where version > 2: throw Problem.desktopOutdated
    default: throw Problem.notAPairingCode
    }
    guard fields["fingerprint"] != nil else { throw Problem.missingFingerprint }
    let qr: PairingCode.QR
    do {
      qr =
        wrapped
        ? try StimServerCLI.decoder.decode(PairingCode.self, from: data).qr
        : try JSONDecoder().decode(PairingCode.QR.self, from: data)
    } catch {
      throw Problem.notAPairingCode
    }
    return try PairingPayload(endpoint: qr.endpoint, token: qr.pairingToken, fingerprint: qr.fingerprint, name: qr.name)
  }

  /// `wss://` to a `*.ts.net` name, or `ws://` to a Tailscale IP literal, with no user, query or fragment. The pinned
  /// server key is the security boundary; this only keeps pairings on the tailnet.
  static func tailnetEndpoint(_ text: String) -> URL? {
    guard let parts = URLComponents(string: text), parts.user == nil, parts.password == nil, parts.query == nil,
      parts.fragment == nil, let scheme = parts.scheme?.lowercased(), let host = parts.host?.lowercased(),
      let url = parts.url
    else { return nil }
    if let port = parts.port, !(1...65535).contains(port) { return nil }
    switch scheme {
    case "wss":
      let name = host.dropLast(".ts.net".count)
      return host.hasSuffix(".ts.net") && !name.isEmpty && !name.hasSuffix(".") ? url : nil
    case "ws": return isTailscaleAddress(host) ? url : nil
    default: return nil
    }
  }

  private static func isTailscaleAddress(_ host: String) -> Bool {
    var v4 = in_addr()
    if inet_pton(AF_INET, host, &v4) == 1 {
      let address = UInt32(bigEndian: v4.s_addr)
      return address >> 22 == (100 << 2 | 1)
    }
    let bare = host.hasPrefix("[") && host.hasSuffix("]") ? String(host.dropFirst().dropLast()) : host
    var v6 = in6_addr()
    guard inet_pton(AF_INET6, bare, &v6) == 1 else { return false }
    let bytes = withUnsafeBytes(of: &v6) { Array($0) }
    return bytes.prefix(6) == [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0]
  }
}

extension PairingPayload {
  /// The separate Endpoint, Token and Fingerprint fields.
  public init(endpoint: String, token: String, fingerprint: String, name: String = "") throws {
    var trimmed = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
    while trimmed.hasSuffix("/") { trimmed.removeLast() }
    guard let url = Self.tailnetEndpoint(trimmed) else { throw Problem.notTailnet }
    let fingerprint = fingerprint.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let secret = Noise.decodeSecret(token.trimmingCharacters(in: .whitespacesAndNewlines)),
      Noise.decodeSecret(fingerprint) != nil
    else { throw Problem.badToken }
    self.name = name
    self.endpoint = url
    self.secret = secret
    self.fingerprint = fingerprint
  }
}
