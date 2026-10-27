import CryptoKit
import Foundation
import Security

/// A pairing with another machine's stim-server. `clientKey` is this pairing's own X25519 private key: forgetting the
/// pairing deletes it, so the server's record for its public key can never authenticate again.
public struct PairedServer: Codable, Equatable, Sendable, Identifiable {
  public var endpoint: URL
  /// The name the person gave the pairing, by default the payload's or `hello.server.name`.
  public var name: String
  /// The server's static public key, pinned at pairing.
  public var serverKey: Data
  public var clientKey: Data
  /// `hello.server.id`. The server supplies it, so it is only a hint, such as for recognizing this Mac's own server.
  public var serverID: String?
  /// The capabilities the last `hello` reported.
  public var capabilities: [String]
  public var pairedAt: Date

  public init(
    endpoint: URL, name: String, serverKey: Data, clientKey: Data, serverID: String?, capabilities: [String],
    pairedAt: Date
  ) {
    self.endpoint = endpoint
    self.name = name
    self.serverKey = serverKey
    self.clientKey = clientKey
    self.serverID = serverID
    self.capabilities = capabilities
    self.pairedAt = pairedAt
  }

  /// The pinned server key's fingerprint, which identifies the pairing.
  public var id: String { Noise.fingerprint(serverKey) }

  /// The credential a returning connection presents, or nil when a stored key is not a valid X25519 key.
  public var credential: (clientKey: Curve25519.KeyAgreement.PrivateKey, NoiseCredential)? {
    guard serverKey.count == Noise.keyBytes,
      let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: clientKey)
    else { return nil }
    return (key, .returning(serverKey: serverKey))
  }
}

/// Where Desktop keeps its pairings with other machines' servers: the data-protection Keychain in a signed build, or
/// memory in a build that cannot reach it.
@MainActor public protocol PairedServerStore: AnyObject {
  /// False for the in-memory store, whose pairings end with the app.
  var keepsPairings: Bool { get }
  func pairings() throws -> [PairedServer]
  /// Adds the pairing, or replaces the one with the same `id`.
  func save(_ pairing: PairedServer) throws
  func forget(id: String) throws
}

@MainActor public final class InMemoryPairedServerStore: PairedServerStore {
  private var stored: [String: PairedServer] = [:]

  public init() {}

  public var keepsPairings: Bool { false }

  public func pairings() throws -> [PairedServer] { stored.values.sorted { $0.pairedAt < $1.pairedAt } }

  public func save(_ pairing: PairedServer) throws { stored[pairing.id] = pairing }

  public func forget(id: String) throws { stored[id] = nil }
}

/// One generic-password item per pairing in the data-protection keychain, readable after the first unlock on this Mac
/// only and never synchronized. Its default access group is the app's application-identifier entitlement, which only
/// a signed release carries.
@MainActor public final class KeychainPairedServerStore: PairedServerStore {
  public struct Failure: Error, LocalizedError {
    public var status: OSStatus
    public var errorDescription: String? {
      "The Keychain refused the pairing (\(SecCopyErrorMessageString(status, nil) as String? ?? "status \(status)"))."
    }
  }

  static let service = "dev.stim.desktop.paired-server"

  /// The Keychain store when this build can use the data-protection keychain, otherwise an in-memory one. An ad-hoc
  /// build has no application-identifier, so the keychain answers `errSecMissingEntitlement`.
  public static func make() -> PairedServerStore {
    let store = KeychainPairedServerStore()
    var query = store.query()
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    let status = SecItemCopyMatching(query as CFDictionary, nil)
    guard status != errSecMissingEntitlement else { return InMemoryPairedServerStore() }
    return store
  }

  private init() {}

  public var keepsPairings: Bool { true }

  private func query(id: String? = nil) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecUseDataProtectionKeychain as String: true,
      kSecAttrService as String: Self.service,
    ]
    if let id { query[kSecAttrAccount as String] = id }
    return query
  }

  public func pairings() throws -> [PairedServer] {
    var query = query()
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    query[kSecReturnData as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess else { throw Failure(status: status) }
    let decoder = JSONDecoder()
    return ((result as? [Data]) ?? []).compactMap { try? decoder.decode(PairedServer.self, from: $0) }
      .sorted { $0.pairedAt < $1.pairedAt }
  }

  public func save(_ pairing: PairedServer) throws {
    let data = try JSONEncoder().encode(pairing)
    let updated = SecItemUpdate(query(id: pairing.id) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if updated == errSecSuccess { return }
    guard updated == errSecItemNotFound else { throw Failure(status: updated) }
    var item = query(id: pairing.id)
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    item[kSecAttrSynchronizable as String] = false
    let added = SecItemAdd(item as CFDictionary, nil)
    guard added == errSecSuccess else { throw Failure(status: added) }
  }

  public func forget(id: String) throws {
    let status = SecItemDelete(query(id: id) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure(status: status) }
  }
}
