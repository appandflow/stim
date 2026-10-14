import Combine
import CryptoKit
import Foundation
import StimKit

/// The device token Stim Desktop holds for the stim-server of one Stim home, in a file only the user can read under
/// Application Support. The server issued it to a loopback connection, so it refuses the token from any other node.
struct LocalServerCredential: Codable, Equatable {
  var deviceID: String
  var deviceToken: String

  /// The release app, as `scripts/release.sh` bundles it. Any other build pairs as Stim Dev with its own token, so it
  /// can share this Mac's stim-server with the release app.
  static let isRelease = Bundle.main.bundleIdentifier == "dev.stim.desktop"

  private static func file(home: String) -> URL {
    let digest = SHA256.hash(data: Data(home.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("\(isRelease ? "Stim Desktop" : "Stim Dev")/stim-server/\(digest).json")
  }

  static func load(home: String) -> LocalServerCredential? {
    (try? Data(contentsOf: file(home: home))).flatMap { try? JSONDecoder().decode(LocalServerCredential.self, from: $0) }
  }

  func save(home: String) {
    let file = Self.file(home: home)
    let manager = FileManager.default
    guard let data = try? JSONEncoder().encode(self),
      (try? manager.createDirectory(
        at: file.deletingLastPathComponent(), withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])) != nil
    else { return }
    let temporary = file.appendingPathExtension("tmp")
    guard manager.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
      return
    }
    _ = try? manager.replaceItemAt(file, withItemAt: temporary)
  }

  static func delete(home: String) {
    try? FileManager.default.removeItem(at: file(home: home))
  }
}

/// Stim Desktop's own connection to the stim-server `ServerController` runs or found on this Mac, over loopback.
/// It pairs with control through `stim-server pair --control` the first time, and once more when the server no longer
/// knows its token, then stops until the server restarts. A read-only pairing gets control through
/// `stim-server devices grant`, once per server. While `ServerController` holds a provisional adoption, the session
/// connects only with a stored token, does not pair, grant or delete a token, and serves only the status feed.
@MainActor final class ServerSession: ObservableObject {
  static let shared = ServerSession(controller: .shared)
  static let deviceName = LocalServerCredential.isRelease ? PairedDevice.desktopName : PairedDevice.devDesktopName

  /// The connection, once the adoption it was made for is verified.
  @Published private(set) var client: ServerClient?
  @Published private(set) var state = ServerClient.State.idle

  private let controller: ServerController
  private var connection: ServerClient?
  private var watch: AnyCancellable?
  private var adoptionWatch: AnyCancellable?
  private var key: String?
  private var repaired = false
  private var granted = false

  init(controller: ServerController) {
    self.controller = controller
    watch = controller.$state.sink { [weak self] _ in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.follow(controller.state) } }
    }
    adoptionWatch = controller.$provisional.sink { [weak self] _ in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.follow(controller.state) } }
    }
  }

  /// The id of the paired device this app is, on the Stim home `home`, so the Phones list can leave it out.
  static func ownDeviceID(home: String) -> String? {
    LocalServerCredential.load(home: home)?.deviceID
  }

  var isOpen: Bool { client?.isOpen == true }

  var statsConnection: (client: ServerClient, home: String)? {
    guard let client, let feed = feedConnection, feed.client === client else { return nil }
    return feed
  }

  var localActionConnection: (client: ServerClient, home: String)? {
    guard let feed = statsConnection, feed.client.hasDesktopAuthority, controller.desktopBootstrap != nil else { return nil }
    return feed
  }

  /// The connection for the status feed, which reads only, so it is offered while the adoption is provisional.
  var feedConnection: (client: ServerClient, home: String)? {
    guard let connection, case .running(let health, _) = controller.state,
      key == "\(controller.port) \(health.stimHome) \(health.version)"
    else { return nil }
    return (connection, health.stimHome)
  }

  var link: ServerLink {
    guard client != nil else {
      switch controller.state {
      case .starting, .off, .running: return .connecting
      case .notReady(.pending, _): return .connecting
      case .notReady(.degraded(let reason), _): return .unavailable("Degraded: \(abbreviatingHome(reason))")
      case .failed(let message): return .unavailable(message)
      }
    }
    switch state {
    case .idle, .connecting: return .connecting
    case .open(let hello): return .open(features: hello.features, capabilities: hello.capabilities)
    case .waiting(_, let reason): return .unavailable("stim-server is unreachable: \(reason) Retrying.")
    case .refused(let error): return .unavailable(error.message)
    }
  }

  private func follow(_ state: ServerController.State) {
    guard case .running(let health, _) = state else {
      replace(key: nil, health: nil)
      return
    }
    let key = "\(controller.port) \(health.stimHome) \(health.version)"
    let verified = controller.adoption.allowsWrites(home: health.stimHome)
    if key != self.key || (verified && client == nil && connection?.isOpen != true) {
      replace(key: key, health: health)
    } else if verified, client !== connection {
      client = connection
    }
  }

  private func replace(key: String?, health: ServerHealth?) {
    connection?.stop()
    connection = nil
    client = nil
    self.key = key
    self.state = .idle
    repaired = false
    granted = false
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
        guard !controller.adoption.isProvisional else {
          throw ServerError(code: "not-connected", message: "The adopted stim-server is not confirmed yet.")
        }
        let cli = await controller.cli()
        guard controller.adoption.allowsWrites(home: home) else {
          throw ServerError(code: "not-connected", message: "The adopted stim-server was not confirmed.")
        }
        let port = controller.port
        let code = try await cli.pair(port: port, control: true)
        pairing = true
        return .pairing(token: code.qr.pairingToken, deviceName: Self.deviceName)
      },
      bootstrap: { [controller] in controller.desktopBootstrap })
    client.onState = { [weak self, weak client] state in
      guard let self, let client, client === self.connection else { return }
      self.state = state
      switch state {
      case .open(let hello):
        if let token = hello.deviceToken, let device = hello.device {
          LocalServerCredential(deviceID: device.id, deviceToken: token).save(home: home)
          self.controller.reloadDevices()
        }
        self.repaired = false
        if !hello.capabilities.contains("control"), !self.granted, let id = hello.device?.id {
          self.granted = true
          Task {
            let cli = await self.controller.cli()
            guard self.controller.adoption.allowsWrites(home: home), client === self.connection,
              (try? await cli.grant(id, control: true)) != nil, client === self.connection
            else { return }
            client.stop()
            client.start()
          }
        }
      case .refused(let error)
      where error.code == "unauthorized" && !pairing && !self.repaired
        && self.controller.adoption.allowsWrites(home: home):
        self.repaired = true
        LocalServerCredential.delete(home: home)
        client.start()
      default: break
      }
    }
    connection = client
    if controller.adoption.allowsWrites(home: home) { self.client = client }
    client.start()
  }
}
