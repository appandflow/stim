import Foundation
import Testing

@testable import StimKit

struct ConnectionsTests {
  private func devices(_ json: String) throws -> [PairedDevice] {
    try StimServerCLI.decoder.decode(PairedDeviceList.self, from: Data(json.utf8)).devices
  }

  private let listed = """
    {"devices":[
      {"id":"phone","name":"iPhone","keyFingerprint":"k-phone","pairedAt":"2026-11-01T10:00:00Z",
       "lastSeenAt":"2026-11-03T10:00:00Z","capabilities":["read","control"],"kind":"phone"},
      {"id":"build","name":"studio","keyFingerprint":"k-studio","pairedAt":"2026-10-30T10:00:00Z",
       "lastSeenAt":"2026-11-02T10:00:00Z","capabilities":["build"],"kind":"build-client"},
      {"id":"host","name":"studio","keyFingerprint":"k-studio","pairedAt":"2026-10-30T10:00:00Z",
       "lastSeenAt":"2026-11-03T12:00:00Z","capabilities":["device-host"],"kind":"device-host-client"},
      {"id":"desk","name":"laptop","keyFingerprint":"k-desk","pairedAt":"2026-10-01T10:00:00Z",
       "capabilities":["read"],"kind":"desktop"},
      {"id":"old","name":"Old pairing","keyFingerprint":"k-old","pairedAt":"2026-09-01T10:00:00Z","capabilities":["read"]},
      {"id":"tests","name":"runner","keyFingerprint":"k-runner","pairedAt":"2026-11-04T10:00:00Z",
       "capabilities":["test"],"kind":"test-client"}
    ],"hostedSessions":[]}
    """

  @Test func groupsIncomingRecordsByClientKeyWithEveryAccessTheyHold() throws {
    let rows = Connections.incoming(try devices(listed))
    #expect(rows.map(\.id) == ["k-phone", "k-studio", "k-desk", "k-old", "k-runner"])
    let studio = rows[1]
    #expect(studio.records.map(\.id) == ["build", "host"])
    #expect(studio.kind == .machine && studio.pairing == nil)
    #expect(studio.access == [.build, .runDevices])
    #expect(studio.lastSeenAt == ISO8601DateFormatter().date(from: "2026-11-03T12:00:00Z"))
    #expect(rows[0].kind == .device && rows[0].access == [.view, .control] && rows[0].pairing?.id == "phone")
    #expect(rows[2].kind == .machine && rows[3].kind == .device)
    #expect(rows[3].lastConnected == "Never connected")
    #expect(rows[4].kind == .machine && rows[4].pairing == nil && rows[4].access == [.test])
    #expect(rows[4].access.allSatisfy { $0.tone == .warning })
  }

  private func pairing(_ byte: UInt8, name: String, capabilities: [String], deviceID: String?) -> PairedServers.Entry {
    let server = PairedServer(
      endpoint: URL(string: "wss://\(name).tail1.ts.net:7443")!, name: name, serverKey: Data(repeating: byte, count: 32),
      clientKey: Data(repeating: 1, count: 32), serverID: nil, capabilities: capabilities, pairedAt: Date(),
      deviceID: deviceID)
    return PairedServers.Entry(id: server.id, kind: .pairing(server), connection: .open)
  }

  @Test func matchesAPairingToTheRemoteMachineThatPinnedTheSameServerKey() throws {
    let mini = pairing(7, name: "mini", capabilities: ["read", "control"], deviceID: "d-mini")
    let floco = pairing(8, name: "floco", capabilities: ["read"], deviceID: nil)
    #expect(mini.id == "S7Bvjk46dxXSAdVz0KpCN2LlXavWGiwCJ4-lbMbSlOA")
    let listing = try JSONDecoder().decode(
      RemoteMachineListing.self,
      from: Data(
        """
        {"machines":[
          {"machine":"mini","priority":1,"deviceHost":null,
           "build":{"machine":"mini","state":"pending","deviceId":"b1","tailnet":{"name":"t.ts.net"},
                    "host":{"name":"Stim Host","screenRecording":true,"accessibility":true}},
           "serverKeyFingerprint":"\(mini.id)","reachability":"reachable","revoke":["stim pairings revoke b1"]},
          {"machine":"studio","priority":2,"build":null,"deviceHost":{"machine":"studio","state":"approved","deviceId":"h2"},
           "serverKeyFingerprint":null,"reachability":"reachable","revoke":[]}],
         "findings":[]}
        """.utf8))
    let doctor = [BuildMachineStatus(machine: "mini", state: .approved, deviceId: "b1")]
    let rows = Connections.outgoing(
      entries: ["mini", "studio"], statuses: doctor, hosts: nil, listing: listing,
      paired: [floco, mini, PairedServers.Entry(id: "broken", kind: .unreadable, connection: .unusable)])
    #expect(rows.map(\.name) == ["mini", "studio", "floco", "Unreadable pairing"])
    #expect(rows[0].pairing?.id == mini.id && rows[0].entry == "mini")
    #expect(rows[0].access == [.view, .control, .build])
    #expect(rows[0].revokeCommands == ["stim pairings revoke b1", "stim pairings revoke d-mini"])
    #expect(rows[1].access == [.runDevices] && rows[1].revokeCommands == ["stim pairings revoke h2"])
    #expect(rows[2].entry == nil && rows[2].access == [.view])
    #expect(rows[2].revokeCommands.isEmpty)
    #expect(rows[3].revokeCommands.isEmpty)
  }

  @Test func neverMergesAPairingIntoARemoteMachineByName() throws {
    let mini = pairing(7, name: "mini", capabilities: ["read"], deviceID: nil)
    let other = try JSONDecoder().decode(
      RemoteMachineListing.self,
      from: Data(#"{"machines":[{"machine":"mini","serverKeyFingerprint":"another-key","revoke":[]}]}"#.utf8))
    for listing in [nil, other] {
      let rows = Connections.outgoing(entries: ["mini"], statuses: nil, hosts: nil, listing: listing, paired: [mini])
      #expect(rows.map(\.entry) == ["mini", nil])
    }
  }
}
