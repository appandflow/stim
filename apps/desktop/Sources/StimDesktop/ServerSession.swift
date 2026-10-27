import Combine
import Foundation
import StimKit

/// A connection to the stim-server that owns what a view shows. `shared` is Stim Desktop's own connection to the
/// stim-server `ServerController` runs or found on this Mac, over that server's Unix socket under its Stim home, where
/// the server gives this user every local capability without pairing. While `ServerController` holds a provisional
/// adoption, it serves only the status feed. A paired server's session connects over the pairing's Noise transport
/// and offers none of the connections that name this Mac's Stim home.
@MainActor final class ServerSession: ObservableObject {
  static let shared = ServerSession(controller: .shared)

  /// The session of the server that owns a workspace or device; nil for a pairing with no session.
  static func session(for owner: ServerOwner) -> ServerSession? {
    switch owner {
    case .local: return shared
    case .paired(let id): return PairedServerSessions.shared.sessions[id]
    }
  }

  /// The name the server shows for this connection: the release app, as `scripts/release.sh` bundles it, or Stim Dev.
  static let clientName = Bundle.main.bundleIdentifier == "dev.stim.desktop" ? "Stim Desktop" : "Stim Dev"
  /// The first protocol served on the Unix socket.
  static let protocolVersion = 2

  /// The connection, once the adoption it was made for is verified.
  @Published private(set) var client: ServerClient?
  @Published private(set) var state = ServerClient.State.idle
  let owner: ServerOwner

  private let controller: ServerController?
  let name: String
  private var connection: ServerClient?
  private var watch: AnyCancellable?
  private var adoptionWatch: AnyCancellable?
  private var key: String?

  init(controller: ServerController) {
    owner = .local
    name = "stim-server"
    self.controller = controller
    watch = controller.$state.sink { [weak self] _ in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.follow(controller.state) } }
    }
    adoptionWatch = controller.$provisional.sink { [weak self] _ in
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.follow(controller.state) } }
    }
  }

  /// `transport` authenticates with the pairing's own key; the client stays connected until `stop()`.
  init(pairing: PairedServer, transport: @escaping ServerTransportFactory) {
    owner = .paired(pairing.id)
    name = pairing.name
    controller = nil
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    let client = ServerClient(
      endpoint: pairing.endpoint, clientName: Self.clientName, clientVersion: version, transport: transport)
    client.onState = { [weak self, weak client] state in
      guard let self, let client, client === self.connection else { return }
      self.state = state
    }
    connection = client
    self.client = client
    client.start()
  }

  /// Ends a paired server's connection, once its pairing is forgotten.
  func stop() {
    guard controller == nil else { return }
    connection?.stop()
  }

  var isOpen: Bool { client?.isOpen == true }

  var statsConnection: (client: ServerClient, home: String)? {
    guard let client, let feed = feedConnection, feed.client === client else { return nil }
    return feed
  }

  var localActionConnection: (client: ServerClient, home: String)? {
    guard let feed = statsConnection, feed.client.hasDesktopAuthority, controller?.desktopBootstrap != nil else {
      return nil
    }
    return feed
  }

  /// The connection for the status feed, which reads only, so it is offered while the adoption is provisional.
  var feedConnection: (client: ServerClient, home: String)? {
    guard let controller, let connection, case .running(let health, _) = controller.state,
      key == "\(controller.port) \(health.stimHome) \(health.version)"
    else { return nil }
    return (connection, health.stimHome)
  }

  var link: ServerLink {
    guard let controller else {
      switch state {
      case .idle, .connecting: return .connecting
      case .open(let hello): return .open(features: hello.features, capabilities: hello.capabilities)
      case .waiting(_, let reason): return .unavailable("Can't reach \(name): \(reason) Retrying.")
      case .refused(let error): return .unavailable(error.message)
      }
    }
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
    guard let controller else { return }
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
    guard let controller else { return }
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

/// One session for each pairing with another machine's server, keyed by `PairedServer.id`.
@MainActor final class PairedServerSessions: ObservableObject {
  static let shared = PairedServerSessions()

  @Published private(set) var sessions: [String: ServerSession] = [:]
  private var watches: [String: AnyCancellable] = [:]

  /// Opens a session for each of `pairings`, keeps a session whose endpoint and name are unchanged, and stops every
  /// other one. A change in any session's state publishes a change here. Each connection reads its pairing's key from `store` as it connects, so a forgotten pairing has none
  /// to send.
  func sync(_ pairings: [PairedServer], store: PairedServerStore) {
    var next: [String: ServerSession] = [:]
    for pairing in pairings {
      if let session = sessions[pairing.id], session.client?.endpoint == pairing.endpoint, session.name == pairing.name {
        next[pairing.id] = session
        continue
      }
      let id = pairing.id
      next[id] = ServerSession(
        pairing: pairing,
        transport: NoiseClientTransport.factory { [weak store] in
          (try? store?.pairings())?.first { $0.id == id }?.credential
        })
    }
    for (id, session) in sessions where next[id] !== session { session.stop() }
    watches = next.mapValues { session in
      session.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
    }
    sessions = next
  }
}
