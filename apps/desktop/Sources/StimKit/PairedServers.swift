import Foundation
import Observation

/// The pairings Desktop keeps with other machines' stim-servers, what each connection is doing, and the pairing in
/// progress. It opens one `ServerClient` per pairing while `start` has run, only to report the connection and to record
/// what each `hello` says; workspace views are not built on it yet.
@MainActor @Observable
public final class PairedServers {
  public enum Connection: Equatable, Sendable {
    case idle
    case connecting
    case open
    /// `hadOpened` is whether this pairing connected since `start`, to tell a dropped connection from one never made.
    case offline(reason: String, retryIn: TimeInterval, hadOpened: Bool)
    case refused(ServerError)
    /// The stored key cannot be used, so no connection is tried.
    case unusable
  }

  public struct Entry: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
      case pairing(PairedServer)
      /// A stored item Desktop cannot read as a pairing; `id` is its Keychain account.
      case unreadable
    }

    public var id: String
    public var kind: Kind
    public var connection: Connection

    public var pairing: PairedServer? {
      if case .pairing(let pairing) = kind { return pairing }
      return nil
    }
  }

  public enum PairingState: Equatable, Sendable {
    case idle
    case pairing(PairingPayload)
    case failed(PairedServerNotice)
    case paired(PairedServer)
  }

  /// A pairing the person just forgot, whose record on the server Forget does not remove.
  public struct Forgotten: Equatable, Sendable {
    public var name: String
    public var command: String
  }

  public struct Dependencies {
    public var store: PairedServerStore
    public var makeClient: @MainActor (PairedServer) -> ServerClient
    public var pair: @MainActor (PairingPayload) async throws -> PairedServer
    /// `hello.server.id` of the server on this Mac, which a pairing must not be with.
    public var localServerID: @MainActor () -> String?

    public init(
      store: PairedServerStore, makeClient: @escaping @MainActor (PairedServer) -> ServerClient,
      pair: @escaping @MainActor (PairingPayload) async throws -> PairedServer,
      localServerID: @escaping @MainActor () -> String?
    ) {
      self.store = store
      self.makeClient = makeClient
      self.pair = pair
      self.localServerID = localServerID
    }
  }

  public private(set) var entries: [Entry] = []
  public private(set) var pairingState = PairingState.idle
  public private(set) var isPairing = false
  public private(set) var forgotten: Forgotten?
  public private(set) var storeError: String?

  private let dependencies: Dependencies
  private var clients: [String: ServerClient] = [:]
  private var opened: Set<String> = []
  private var started = false

  public init(_ dependencies: Dependencies) {
    self.dependencies = dependencies
    reload()
  }

  /// The production wiring: returning connections and new pairings use Noise.
  public static func live(
    store: PairedServerStore, deviceName: String, clientName: String, clientVersion: String,
    localServerID: @escaping @MainActor () -> String?
  ) -> PairedServers {
    PairedServers(
      Dependencies(
        store: store,
        makeClient: { pairing in
          ServerClient(
            endpoint: pairing.endpoint, clientName: clientName, clientVersion: clientVersion,
            transport: NoiseClientTransport.factory {
              (try? store.pairings())?.first { $0.id == pairing.id }?.credential
            })
        },
        pair: {
          try await NoisePairing.pair(
            $0, store: store, deviceName: deviceName, clientName: clientName, clientVersion: clientVersion)
        },
        localServerID: localServerID))
  }

  public var keepsPairings: Bool { dependencies.store.keepsPairings }

  public func reload() {
    do {
      let pairings = try dependencies.store.pairings()
      let unreadable = try dependencies.store.unreadable()
      storeError = nil
      let previous = Dictionary(uniqueKeysWithValues: entries.map { ($0.id, $0.connection) })
      entries =
        pairings.map { Entry(id: $0.id, kind: .pairing($0), connection: previous[$0.id] ?? .idle) }
        + unreadable.map { Entry(id: $0, kind: .unreadable, connection: .unusable) }
    } catch {
      storeError = error.localizedDescription
    }
    if started { connectMissing() }
  }

  public func start() {
    started = true
    connectMissing()
  }

  public func stop() {
    started = false
    for client in clients.values { client.stop() }
    clients = [:]
    opened = []
    entries = entries.map { entry in
      var entry = entry
      if entry.kind != .unreadable { entry.connection = .idle }
      return entry
    }
  }

  public func reconnect(id: String) {
    guard started, let pairing = entry(id)?.pairing else { return }
    clients[id]?.stop()
    clients[id] = nil
    connect(pairing)
  }

  public func forget(id: String) {
    guard !isPairing, let entry = entry(id) else { return }
    clients[id]?.stop()
    clients[id] = nil
    do {
      try dependencies.store.forget(id: id)
    } catch {
      storeError = error.localizedDescription
      return
    }
    if let pairing = entry.pairing {
      forgotten = Forgotten(
        name: pairing.name.isEmpty ? "the machine" : pairing.name,
        command: PairedServerWording.revokeCommand(deviceID: pairing.deviceID))
    }
    reload()
  }

  public func dismissForgotten() { forgotten = nil }

  public func dismissPairing() {
    guard !isPairing else { return }
    pairingState = .idle
  }

  /// Pairs from the text of `stim-server pair`. A pairing while another runs is ignored; the caller cancels the task
  /// running the first.
  public func pair(_ text: String) async {
    guard !isPairing else { return }
    let payload: PairingPayload
    do {
      payload = try PairingPayload.parse(text)
    } catch {
      let problem = (error as? PairingPayload.Problem) ?? .notAPairingCode
      pairingState = .failed(PairedServerWording.notice(for: problem))
      return
    }
    isPairing = true
    pairingState = .pairing(payload)
    forgotten = nil
    defer {
      isPairing = false
      reload()
    }
    do {
      let pairing = try await dependencies.pair(payload)
      if let local = dependencies.localServerID(), pairing.serverID == local {
        try? dependencies.store.forget(id: pairing.id)
        let revoke = PairedServerWording.revokeCommand(deviceID: pairing.deviceID)
        pairingState = .failed(
          PairedServerWording.notice(
            for: ServerError(code: "own-server", message: revoke), context: .pairing, name: pairing.name))
      } else {
        pairingState = .paired(pairing)
      }
    } catch is CancellationError {
      pairingState = .idle
    } catch {
      let failure =
        (error as? ServerError) ?? ServerError(code: "pairing-failed", message: error.localizedDescription)
      pairingState = .failed(PairedServerWording.notice(for: failure, context: .pairing, name: payload.name))
    }
  }

  private func entry(_ id: String) -> Entry? { entries.first { $0.id == id } }

  private func connectMissing() {
    let ids = Set(entries.compactMap { $0.pairing?.id })
    for id in clients.keys where !ids.contains(id) {
      clients[id]?.stop()
      clients[id] = nil
    }
    for case .pairing(let pairing) in entries.map(\.kind) where clients[pairing.id] == nil { connect(pairing) }
  }

  private func connect(_ pairing: PairedServer) {
    guard pairing.credential != nil else { return set(pairing.id, .unusable) }
    let client = dependencies.makeClient(pairing)
    clients[pairing.id] = client
    client.onState = { [weak self, weak client] state in
      guard let self, let client, self.clients[pairing.id] === client else { return }
      self.apply(state, for: pairing.id)
    }
    set(pairing.id, .connecting)
    client.start()
  }

  private func apply(_ state: ServerClient.State, for id: String) {
    switch state {
    case .idle: set(id, .idle)
    case .connecting: set(id, .connecting)
    case .open(let hello):
      opened.insert(id)
      confirm(id, hello)
      set(id, .open)
    case .waiting(let retryIn, let reason):
      set(id, .offline(reason: reason, retryIn: retryIn, hadOpened: opened.contains(id)))
    case .refused(let error): set(id, .refused(error))
    }
  }

  /// Records what a `hello` says about the pairing, which also finishes a pairing kept as unconfirmed. It never
  /// stores a pairing that was forgotten while the connection was opening.
  private func confirm(_ id: String, _ hello: HelloResult) {
    guard var pairing = (try? dependencies.store.pairings())?.first(where: { $0.id == id }) else { return }
    let before = pairing
    pairing.serverID = hello.server.id ?? pairing.serverID
    pairing.deviceID = hello.device?.id ?? pairing.deviceID
    pairing.capabilities = hello.capabilities
    if pairing.name.isEmpty { pairing.name = hello.server.name }
    guard pairing != before else { return }
    do {
      try dependencies.store.save(pairing)
    } catch {
      storeError = error.localizedDescription
      return
    }
    if let index = entries.firstIndex(where: { $0.id == id }) { entries[index].kind = .pairing(pairing) }
  }

  private func set(_ id: String, _ connection: Connection) {
    guard let index = entries.firstIndex(where: { $0.id == id }), entries[index].connection != connection else { return }
    entries[index].connection = connection
  }
}
