import Combine
import Foundation
import StimKit

/// Stim Desktop's own connection to the stim-server `ServerController` runs or found on this Mac, over that server's
/// Unix socket under its Stim home, where the server gives this user every local capability without pairing. While
/// `ServerController` holds a provisional adoption, the session serves only the status feed.
@MainActor final class ServerSession: ObservableObject {
  static let shared = ServerSession(controller: .shared)
  /// The name the server shows for this connection: the release app, as `scripts/release.sh` bundles it, or Stim Dev.
  static let clientName = Bundle.main.bundleIdentifier == "dev.stim.desktop" ? "Stim Desktop" : "Stim Dev"
  /// The first protocol served on the Unix socket.
  static let protocolVersion = 2

  /// The connection, once the adoption it was made for is verified.
  @Published private(set) var client: ServerClient?
  @Published private(set) var state = ServerClient.State.idle

  private let controller: ServerController
  private var connection: ServerClient?
  private var watch: AnyCancellable?
  private var adoptionWatch: AnyCancellable?
  private var key: String?

  init(controller: ServerController) {
    self.controller = controller
    watch = controller.$state.sink { [weak self] _ in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.follow(controller.state) } }
    }
    adoptionWatch = controller.$provisional.sink { [weak self] _ in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.follow(controller.state) } }
    }
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
    if case .running(let health, _) = controller.state, health.protocolVersion < Self.protocolVersion {
      return .unavailable(
        "This stim-server \(health.version) is too old for this Stim Desktop. Update it, or clear the stim-server override in Settings."
      )
    }
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
    guard let health, health.protocolVersion >= Self.protocolVersion else { return }
    let home = health.stimHome
    let socket = StimHome.localSocket(home: home)
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    let client = ServerClient(
      endpoint: socket, clientName: Self.clientName, clientVersion: version, serverPort: controller.port,
      bootstrap: { [controller] in controller.desktopBootstrap })
    client.onState = { [weak self, weak client] state in
      guard let self, let client, client === self.connection else { return }
      self.state = state
    }
    connection = client
    if controller.adoption.allowsWrites(home: home) { self.client = client }
    client.start()
  }
}
