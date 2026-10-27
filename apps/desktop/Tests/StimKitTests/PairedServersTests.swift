import CryptoKit
import Foundation
import Testing

@testable import StimKit

@MainActor private final class ScriptedStore: PairedServerStore {
  var stored: [String: PairedServer] = [:]
  var unreadableIDs: [String] = []
  var keepsPairings: Bool { true }

  func pairings() throws -> [PairedServer] { stored.values.sorted { $0.pairedAt < $1.pairedAt } }
  func unreadable() throws -> [String] { unreadableIDs }
  func save(_ pairing: PairedServer) throws { stored[pairing.id] = pairing }

  func forget(id: String) throws {
    stored[id] = nil
    unreadableIDs.removeAll { $0 == id }
  }
}

/// Answers `hello` as a server would, or refuses the connection.
@MainActor private final class HelloTransport: ServerTransport {
  var onEvent: (@MainActor (ServerTransportEvent) -> Void)?
  var refusal: ServerError?
  var serverID: String? = "floco-id"
  var capabilities = ["read"]

  func close() {}

  func send(_ text: String) {
    guard case .object(let request)? = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)),
      let id = request["id"], request["method"]?.string == "hello"
    else { return }
    if let refusal {
      Task { @MainActor in self.onEvent?(.refused(refusal)) }
      return
    }
    let result: JSONValue = .object([
      "protocol": .number(2),
      "server": .object(
        [
          "id": serverID.map(JSONValue.string) ?? .null, "name": .string("floco"), "version": .string("1"),
          "stim": .string("1"),
        ]),
      "capabilities": .array(capabilities.map(JSONValue.string)),
      "device": .object(["id": .string("device-7"), "name": .string("Test Mac")]),
    ])
    let reply = String(decoding: try! JSONEncoder().encode(JSONValue.object(["id": id, "result": result])), as: UTF8.self)
    Task { @MainActor in self.onEvent?(.text(reply)) }
  }
}

private func pairing(_ seed: UInt8, name: String = "floco", capabilities: [String] = ["read"], serverID: String? = nil)
  -> PairedServer
{
  PairedServer(
    endpoint: URL(string: "wss://floco.tail7f5754.ts.net:7443")!, name: name,
    serverKey: Data(repeating: seed, count: 32), clientKey: Curve25519.KeyAgreement.PrivateKey().rawRepresentation,
    serverID: serverID, capabilities: capabilities, pairedAt: Date(timeIntervalSince1970: Double(seed)))
}

@MainActor private final class Rig {
  let store = ScriptedStore()
  let transport = HelloTransport()
  var servers: PairedServers!

  init(pair: @escaping @MainActor (ScriptedStore) async throws -> PairedServer = { _ in throw CancellationError() }) {
    let store = self.store
    let transport = self.transport
    servers = PairedServers(
      PairedServers.Dependencies(
        store: store,
        makeClient: { pairing in
          ServerClient(
            endpoint: pairing.endpoint, clientName: "test", clientVersion: "1",
            transport: { _, onEvent in
              transport.onEvent = onEvent
              return transport
            }, scheduler: { _, _ in {} })
        },
        pair: { _ in try await pair(store) }, localServerID: { nil }))
  }

  func settle(_ done: () -> Bool) async {
    for _ in 0..<400 where !done() { try? await Task.sleep(for: .milliseconds(5)) }
  }
}

private let code =
  #"{"v":2,"name":"floco","endpoint":"wss://floco.tail7f5754.ts.net:7443","pairingToken":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8","fingerprint":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}"#

@MainActor @Suite struct PairedServersTests {
  @Test func aKeychainItemThatDoesNotDecodeIsReportedAndForgettable() throws {
    let good = pairing(1)
    let data = try JSONEncoder().encode(good)
    var future = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    future["pairedAt"] = "not a date"
    let items: [(id: String, data: Data)] = [
      (good.id, data), ("broken", try JSONSerialization.data(withJSONObject: future)),
      ("garbage", Data("{".utf8)), ("someone-elses-account", data),
    ]
    let stored = StoredPairings(items: items)
    #expect(stored.pairings == [good])
    #expect(stored.unreadable == ["broken", "garbage", "someone-elses-account"])

    let rig = Rig()
    rig.store.stored[good.id] = good
    rig.store.unreadableIDs = ["broken"]
    rig.servers.reload()
    #expect(rig.servers.entries.map(\.id) == [good.id, "broken"])
    #expect(rig.servers.entries[1].kind == .unreadable)
    #expect(rig.servers.entries[1].status.title == "Unreadable pairing")
    rig.servers.forget(id: "broken")
    #expect(rig.servers.entries.map(\.id) == [good.id])
    #expect(rig.store.unreadableIDs.isEmpty)
  }

  @Test func everyRefusalCodeHasItsOwnWording() {
    let fallback = PairedServerWording.notice(
      for: ServerError(code: "something-else", message: "x"), context: .pairing, name: "floco")
    for code in ServerProtocol.refusalCodes.union(PairedServerWording.localCodes) {
      for context in [PairedServerWording.Context.pairing, .connection] {
        let notice = PairedServerWording.notice(for: ServerError(code: code, message: "detail"), context: context, name: "floco")
        #expect(notice.title != fallback.title, "\(code) shows the generic title")
        #expect(!notice.detail.isEmpty, "\(code)")
      }
    }
  }

  @Test func aPairingKeptAsUnconfirmedShowsUpAndFinishesWhenAHelloSucceeds() async throws {
    let kept = pairing(2, name: "", capabilities: [])
    let rig = Rig(pair: { store in
      store.stored[kept.id] = kept
      throw ServerError(code: "pairing-unconfirmed", message: "It never answered.")
    })
    await rig.servers.pair(code)
    guard case .failed(let notice) = rig.servers.pairingState else {
      Issue.record("the pairing ended \(rig.servers.pairingState)")
      return
    }
    #expect(notice.title.contains("did not confirm"))
    #expect(rig.servers.entries.map(\.id) == [kept.id])
    #expect(rig.servers.entries[0].pairing?.isConfirmed == false)

    rig.servers.start()
    await rig.settle { rig.servers.entries.first?.connection == .open }
    let confirmed = try #require(rig.servers.entries.first?.pairing)
    #expect(confirmed.isConfirmed)
    #expect(confirmed.name == "floco")
    #expect(confirmed.deviceID == "device-7")
    #expect(try rig.store.pairings() == [confirmed])
    #expect(rig.servers.entries[0].status.title == "Connected")
    rig.servers.stop()
  }

  @Test func forgettingAPairingStopsItsConnectionAndALateHelloDoesNotBringItBack() async throws {
    let rig = Rig()
    let kept = pairing(3, name: "floco", capabilities: ["read"], serverID: "floco-id")
    rig.store.stored[kept.id] = kept
    rig.servers.reload()
    rig.servers.start()
    await rig.settle { rig.servers.entries.first?.connection == .open }
    rig.servers.forget(id: kept.id)
    #expect(rig.servers.entries.isEmpty)
    #expect(try rig.store.pairings().isEmpty)
    #expect(rig.servers.forgotten?.command == "stim-server devices revoke device-7")
    rig.servers.stop()
  }

  @Test func aSecondPairingWhileOneRunsIsIgnored() async {
    var calls = 0
    var release: CheckedContinuation<Void, Never>?
    let rig = Rig(pair: { _ in
      calls += 1
      await withCheckedContinuation { release = $0 }
      throw ServerError(code: "unknown-secret", message: "")
    })
    let first = Task { await rig.servers.pair(code) }
    await rig.settle { release != nil }
    #expect(rig.servers.isPairing)
    await rig.servers.pair(code)
    #expect(calls == 1)
    release?.resume()
    await first.value
    #expect(!rig.servers.isPairing)
    guard case .failed(let notice) = rig.servers.pairingState else { return Issue.record("not failed") }
    #expect(notice.title.contains("expired"))
  }

  @Test func pairingWithThisMacsOwnServerIsRefusedAndTheKeyIsForgotten() async throws {
    let store = ScriptedStore()
    let own = pairing(4, serverID: "mine")
    let servers = PairedServers(
      PairedServers.Dependencies(
        store: store, makeClient: { _ in fatalError("not started") },
        pair: { _ in
          var saved = own
          saved.deviceID = "device-9"
          store.stored[saved.id] = saved
          return saved
        }, localServerID: { "mine" }))
    await servers.pair(code)
    guard case .failed(let notice) = servers.pairingState else { return Issue.record("not refused") }
    #expect(notice.title.contains("own server"))
    #expect(notice.command == "stim-server devices revoke device-9")
    #expect(try store.pairings().isEmpty)
    #expect(servers.entries.isEmpty)
  }

  @Test func aRevokedPairingShowsTheRefusalAndStaysForgettable() async throws {
    let rig = Rig()
    rig.transport.refusal = NoiseClientTransport.refusal("unauthorized")
    let kept = pairing(5)
    rig.store.stored[kept.id] = kept
    rig.servers.reload()
    rig.servers.start()
    await rig.settle { rig.servers.entries.first?.status.title.contains("no longer knows") == true }
    #expect(rig.servers.entries[0].status.title == "floco no longer knows this Mac")
    rig.servers.forget(id: kept.id)
    #expect(rig.servers.entries.isEmpty)
    rig.servers.stop()
  }
}
