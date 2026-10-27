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
  /// The id the server gave this pairing's record, which `stim-server devices revoke` takes; nil until a `hello`.
  public var deviceID: String?

  public init(
    endpoint: URL, name: String, serverKey: Data, clientKey: Data, serverID: String?, capabilities: [String],
    pairedAt: Date, deviceID: String? = nil
  ) {
    self.endpoint = endpoint
    self.name = name
    self.serverKey = serverKey
    self.clientKey = clientKey
    self.serverID = serverID
    self.capabilities = capabilities
    self.pairedAt = pairedAt
    self.deviceID = deviceID
  }

  /// Whether a `hello` has confirmed the pairing: a server reports at least `read` to a client it recorded.
  public var isConfirmed: Bool { !capabilities.isEmpty }

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
  /// The ids of stored items that cannot be read as a pairing, which `forget` still removes.
  func unreadable() throws -> [String]
  /// Adds the pairing, or replaces the one with the same `id`.
  func save(_ pairing: PairedServer) throws
  func forget(id: String) throws
}

@MainActor public final class InMemoryPairedServerStore: PairedServerStore {
  private var stored: [String: PairedServer] = [:]

  public init() {}

  public var keepsPairings: Bool { false }

  public func pairings() throws -> [PairedServer] { stored.values.sorted { $0.pairedAt < $1.pairedAt } }

  public func unreadable() throws -> [String] { [] }

  public func save(_ pairing: PairedServer) throws { stored[pairing.id] = pairing }

  public func forget(id: String) throws { stored[id] = nil }
}

/// The Keychain items read as pairings, and the ids of those that could not be, such as an item a later version wrote
/// with a field this one does not know.
struct StoredPairings: Equatable {
  var pairings: [PairedServer]
  var unreadable: [String]

  init(pairings: [PairedServer], unreadable: [String]) {
    self.pairings = pairings
    self.unreadable = unreadable
  }

  init(items: [(id: String, data: Data)]) {
    let decoder = JSONDecoder()
    var pairings: [PairedServer] = []
    var unreadable: [String] = []
    for item in items {
      if let pairing = try? decoder.decode(PairedServer.self, from: item.data), pairing.id == item.id {
        pairings.append(pairing)
      } else {
        unreadable.append(item.id)
      }
    }
    self.pairings = pairings.sorted { $0.pairedAt < $1.pairedAt }
    self.unreadable = unreadable.sorted()
  }
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
  static let probeService = "dev.stim.desktop.paired-server-probe"

  /// The Keychain store when this build can use the data-protection keychain, otherwise an in-memory one. An ad-hoc
  /// build has no application-identifier: a read answers `errSecItemNotFound` as it would for a build that can use
  /// the keychain, and only a write answers `errSecMissingEntitlement`, so this writes a probe item and removes it.
  public static func make() -> PairedServerStore {
    let probe: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecUseDataProtectionKeychain as String: true,
      kSecAttrService as String: probeService,
      kSecAttrAccount as String: "probe",
    ]
    var item = probe
    item[kSecValueData as String] = Data("probe".utf8)
    item[kSecAttrSynchronizable as String] = false
    SecItemDelete(probe as CFDictionary)
    let added = SecItemAdd(item as CFDictionary, nil)
    if added == errSecSuccess { SecItemDelete(probe as CFDictionary) }
    guard added != errSecMissingEntitlement else { return InMemoryPairedServerStore() }
    return KeychainPairedServerStore()
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

  public func pairings() throws -> [PairedServer] { try read().pairings }

  public func unreadable() throws -> [String] { try read().unreadable }

  private func read() throws -> StoredPairings {
    var query = query()
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    query[kSecReturnData as String] = true
    query[kSecReturnAttributes as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return StoredPairings(pairings: [], unreadable: []) }
    guard status == errSecSuccess else { throw Failure(status: status) }
    let items = ((result as? [[String: Any]]) ?? []).compactMap { item -> (id: String, data: Data)? in
      guard let id = item[kSecAttrAccount as String] as? String, let data = item[kSecValueData as String] as? Data
      else { return nil }
      return (id, data)
    }
    return StoredPairings(items: items)
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
