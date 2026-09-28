import Combine
import Foundation
import Security
import StimKit

/// The device token Stim Desktop holds for the stim-server of one Stim home, in the login keychain. It was issued
/// to a loopback connection, so the server refuses it from any other node.
struct LocalServerCredential: Codable, Equatable {
  var deviceID: String
  var deviceToken: String

  private static let service = "dev.stim.desktop.stim-server"
  /// What this process saved, so a keychain that refuses the item does not make the app pair on every reconnect.
  @MainActor private static var saved: [String: LocalServerCredential] = [:]

  private static func query(home: String) -> [CFString: Any] {
    [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: home]
  }

  @MainActor static func load(home: String) -> LocalServerCredential? {
    if let credential = saved[home] { return credential }
    var query = query(home: home)
    query[kSecReturnData] = true
    query[kSecMatchLimit] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else {
      return nil
    }
    return try? JSONDecoder().decode(LocalServerCredential.self, from: data)
  }

  @MainActor func save(home: String) {
    Self.saved[home] = self
    guard let data = try? JSONEncoder().encode(self) else { return }
    let query = Self.query(home: home)
    if SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary) == errSecItemNotFound {
      var item = query
      item[kSecValueData] = data
      SecItemAdd(item as CFDictionary, nil)
    }
  }

  @MainActor static func delete(home: String) {
    saved[home] = nil
    SecItemDelete(query(home: home) as CFDictionary)
  }
}

/// Stim Desktop's own connection to the stim-server `ServerController` runs or found on this Mac, over loopback.
/// It pairs read-only through `stim-server pair` the first time, and once more when the server no longer knows its
/// token, then stops until the server restarts.
@MainActor final class ServerSession: ObservableObject {
  static let shared = ServerSession(controller: .shared)
  static let deviceName = "Stim Desktop"

  @Published private(set) var client: ServerClient?
  @Published private(set) var state = ServerClient.State.idle

  private let controller: ServerController
  private var watch: AnyCancellable?
  private var key: String?
  private var repaired = false

  init(controller: ServerController) {
    self.controller = controller
    watch = controller.$state.sink { [weak self] state in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.follow(state) } }
    }
  }

  /// The id of the paired device this app is, on the Stim home `home`, so the Phones list can leave it out.
  static func ownDeviceID(home: String) -> String? {
    LocalServerCredential.load(home: home)?.deviceID
  }

  var isOpen: Bool { client?.isOpen == true }

  private func follow(_ state: ServerController.State) {
    guard case .running(let health, _) = state else {
      replace(key: nil, health: nil)
      return
    }
    let key = "\(controller.port) \(health.stimHome) \(health.version)"
    if key != self.key { replace(key: key, health: health) }
  }

  private func replace(key: String?, health: ServerHealth?) {
    client?.stop()
    client = nil
    self.key = key
    self.state = .idle
    repaired = false
    guard let health, let endpoint = URL(string: "ws://127.0.0.1:\(controller.port)") else { return }
    let home = health.stimHome
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    var pairing = false
    let client = ServerClient(
      endpoint: endpoint, clientName: Self.deviceName, clientVersion: version,
      auth: { [controller] in
        if let credential = LocalServerCredential.load(home: home) {
          pairing = false
          return .device(token: credential.deviceToken)
        }
        let cli = await controller.cli()
        let port = controller.port
        let code = try await Task.detached { try cli.pair(port: port, control: false) }.value
        pairing = true
        return .pairing(token: code.qr.pairingToken, deviceName: Self.deviceName)
      })
    client.onState = { [weak self, weak client] state in
      guard let self, let client, client === self.client else { return }
      self.state = state
      switch state {
      case .open(let hello):
        if let token = hello.deviceToken, let device = hello.device {
          LocalServerCredential(deviceID: device.id, deviceToken: token).save(home: home)
          self.controller.reloadDevices()
        }
        self.repaired = false
      case .refused(let error) where error.code == "unauthorized" && !pairing && !self.repaired:
        self.repaired = true
        LocalServerCredential.delete(home: home)
        client.start()
      default: break
      }
    }
    self.client = client
    client.start()
  }
}
