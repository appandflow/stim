import Foundation

/// A checked `stim-server pair` payload: a tailnet or local network endpoint, the single-use token's 32 bytes and the
/// server key's fingerprint, which Desktop always requires.
public struct PairingPayload: Equatable, Sendable {
  public enum Problem: Error, Equatable, LocalizedError {
    case notAPairingCode
    case serverOutdated
    case desktopOutdated
    case missingFingerprint
    case badToken
    case unsupportedEndpoint

    public var errorDescription: String? {
      switch self {
      case .notAPairingCode: return "This is not a Stim pairing code. Paste the output of stim-server pair."
      case .serverOutdated: return "This pairing code is from an older stim-server. Update stim-server on that machine."
      case .desktopOutdated: return "This pairing code needs a newer Stim Desktop."
      case .missingFingerprint: return "The pairing code has no server fingerprint, so Stim Desktop cannot check the server."
      case .badToken: return "The pairing token or fingerprint is not 43 letters, digits, - and _."
      case .unsupportedEndpoint:
        return
          "The endpoint must be wss:// to a .ts.net name, or ws:// to a Tailscale or private network IP address. An endpoint on 127.0.0.1 only works on the machine that printed it."
      }
    }
  }

  public var name: String
  public var endpoint: URL
  public var secret: Data
  public var fingerprint: String
  public var network: Network

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

  /// Where an accepted endpoint lives: a Tailscale name or address, or a private address on the local network.
  public enum Network: Equatable, Sendable {
    case tailnet
    case localNetwork
  }

  /// `wss://` to a `*.ts.net` name, or `ws://` to a Tailscale or private IP literal other than loopback, with no
  /// user, query or fragment. Plain `ws://` is safe because the Noise session encrypts it; the pinned server key is
  /// the security boundary, and a name that is not an address is never accepted because it cannot be checked.
  static func accepted(_ text: String) -> (url: URL, network: Network)? {
    guard let parts = URLComponents(string: text), parts.user == nil, parts.password == nil, parts.query == nil,
      parts.fragment == nil, let scheme = parts.scheme?.lowercased(), let host = parts.host?.lowercased(),
      let url = parts.url
    else { return nil }
    if let port = parts.port, !(1...65535).contains(port) { return nil }
    switch scheme {
    case "wss":
      let name = host.dropLast(".ts.net".count)
      return host.hasSuffix(".ts.net") && !name.isEmpty && !name.hasSuffix(".") ? (url, .tailnet) : nil
    case "ws": return network(ofAddress: host).map { (url, $0) }
    default: return nil
    }
  }

  private static func network(ofAddress host: String) -> Network? {
    var v4 = in_addr()
    if inet_pton(AF_INET, host, &v4) == 1 {
      let address = UInt32(bigEndian: v4.s_addr)
      let first = address >> 24
      let second = (address >> 16) & 0xff
      if address >> 22 == (100 << 2 | 1) { return .tailnet }
      let isPrivate =
        first == 10 || (first == 172 && (16...31).contains(second)) || (first == 192 && second == 168)
        || (first == 169 && second == 254)
      return isPrivate ? .localNetwork : nil
    }
    let bare = host.hasPrefix("[") && host.hasSuffix("]") ? String(host.dropFirst().dropLast()) : host
    var v6 = in6_addr()
    guard inet_pton(AF_INET6, bare, &v6) == 1 else { return nil }
    let bytes = withUnsafeBytes(of: &v6) { Array($0) }
    if bytes.prefix(6) == [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0] { return .tailnet }
    let isPrivate = bytes[0] & 0xfe == 0xfc || (bytes[0] == 0xfe && bytes[1] & 0xc0 == 0x80)
    return isPrivate ? .localNetwork : nil
  }
}

extension PairingPayload {
  /// The separate Endpoint, Token and Fingerprint fields.
  public init(endpoint: String, token: String, fingerprint: String, name: String = "") throws {
    var trimmed = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
    while trimmed.hasSuffix("/") { trimmed.removeLast() }
    guard let (url, network) = Self.accepted(trimmed) else { throw Problem.unsupportedEndpoint }
    let fingerprint = fingerprint.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let secret = Noise.decodeSecret(token.trimmingCharacters(in: .whitespacesAndNewlines)),
      Noise.decodeSecret(fingerprint) != nil
    else { throw Problem.badToken }
    self.name = name
    self.endpoint = url
    self.network = network
    self.secret = secret
    self.fingerprint = fingerprint
  }
}
