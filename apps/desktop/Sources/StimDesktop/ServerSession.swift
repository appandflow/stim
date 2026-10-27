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

  static func link(for owner: ServerOwner) -> ServerLink {
    session(for: owner)?.link ?? .connecting
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
  @Published private(set) var name: String
  @Published private(set) var offlineSince: Date?
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

  init(pairing: PairedServer, client: ServerClient, offlineSince: Date? = nil) {
    owner = .paired(pairing.id)
    self.offlineSince = offlineSince
    name = pairing.name
    controller = nil
    connection = client
    self.client = client
    state = client.state
  }

  fileprivate func follow(pairing: PairedServer, client: ServerClient) {
    guard controller == nil, client === connection else { return }
    if name != pairing.name { name = pairing.name }
    if state != client.state {
      if case .open = state { offlineSince = Date() } else if case .open = client.state { offlineSince = nil }
      state = client.state
    }
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

@MainActor final class PairedServerSessions: ObservableObject {
  static let shared = PairedServerSessions()

  @Published private(set) var sessions: [String: ServerSession] = [:]
  @Published private(set) var entries: [PairedServers.Entry] = []
  private var servers: PairedServers?
  private var offlineSince: [String: Date] = [:]
  private var knownLocalServerID: String?

  func setEnabled(_ enabled: Bool) {
    if enabled, servers == nil {
      let servers = PairedServers.shared
      self.servers = servers
      servers.onChange = { [weak self, weak servers] in
        guard let self, let servers, self.servers === servers else { return }
        self.sync(servers, localServerID: self.lastLocalServerID())
      }
      servers.start()
    } else if !enabled, let servers {
      self.servers = nil
      servers.onChange = nil
      servers.stop()
      sessions = [:]
      entries = []
    }
  }

  func localServerChanged() {
    guard let servers else { return }
    sync(servers, localServerID: lastLocalServerID())
  }

  private func lastLocalServerID() -> String? {
    if let id = Self.localServerID { knownLocalServerID = id }
    return knownLocalServerID
  }

  static var localServerID: String? {
    if case .open(let hello) = ServerSession.shared.state { return hello.server.id }
    return nil
  }

  func sync(_ servers: PairedServers, localServerID: String?) {
    var next: [String: ServerSession] = [:]
    var shown: [PairedServers.Entry] = []
    for entry in servers.entries {
      guard let pairing = entry.pairing else { continue }
      let client = servers.client(for: pairing.id)
      if let local = localServerID, pairing.serverID == local || client?.helloServerID == local { continue }
      shown.append(entry)
      if let previous = sessions[pairing.id] {
        offlineSince[pairing.id] = previous.isOpen ? Date() : previous.offlineSince
      }
      guard let client else { continue }
      if let session = sessions[pairing.id], session.client === client {
        session.follow(pairing: pairing, client: client)
        next[pairing.id] = session
      } else {
        next[pairing.id] = ServerSession(pairing: pairing, client: client, offlineSince: offlineSince[pairing.id])
      }
    }
    offlineSince = offlineSince.filter { id, _ in shown.contains { $0.id == id } }
    sessions = next
    entries = shown.sorted {
      ($0.pairing?.name.lowercased() ?? "", $0.id) < ($1.pairing?.name.lowercased() ?? "", $1.id)
    }
  }
}

extension ServerClient {
  fileprivate var helloServerID: String? {
    if case .open(let hello) = state { return hello.server.id }
    return nil
  }
}
