#if DEBUG
  import Foundation
  import StimKit
  import SwiftUI

  /// Settings > Connections with fixed connections in both directions; nothing it shows is read or changed.
  struct ConnectionsPlayground: View {
    var segment: ConnectionsSegment
    var now: Date
    var height: CGFloat = 640
    @State private var allows = true
    @State private var awake = false

    private static let decoder: JSONDecoder = {
      let decoder = JSONDecoder()
      decoder.dateDecodingStrategy = .iso8601
      return decoder
    }()

    private func iso(_ offset: TimeInterval) -> String {
      ISO8601DateFormatter().string(from: now.addingTimeInterval(offset))
    }

    private var devices: [PairedDevice] {
      let json = """
        [{"id":"p-7c1d","name":"Janic's iPhone","keyFingerprint":"phone-key","pairedAt":"\(iso(-86_400 * 9))",
          "lastSeenAt":"\(iso(-3_600 * 2))","capabilities":["read","control"],"kind":"phone"},
         {"id":"b-91aa","name":"studio","from":"studio.tail1234.ts.net","keyFingerprint":"studio-key",
          "pairedAt":"\(iso(-86_400 * 3))","lastSeenAt":"\(iso(-300))","capabilities":["build"],"kind":"build-client"},
         {"id":"h-0f3e","name":"studio","from":"studio.tail1234.ts.net","keyFingerprint":"studio-key",
          "pairedAt":"\(iso(-86_400 * 3))","lastSeenAt":"\(iso(-900))","capabilities":["device-host"],
          "kind":"device-host-client"},
         {"id":"p-55b0","name":"Stim Desktop","keyFingerprint":"desktop-key","pairedAt":"\(iso(-86_400 * 20))",
          "capabilities":["read"],"kind":"phone"}]
        """
      return (try? Self.decoder.decode([PairedDevice].self, from: Data(json.utf8))) ?? []
    }

    private var shares: [WebShare] {
      let json = """
        [{"id":"s-1","workspace":"/Users/me/app/.worktrees/checkout","platform":"ios","slot":"default","physical":false,
          "control":true,"expiresAt":"\(iso(2_520))","viewers":1,"auth":"generated"}]
        """
      return (try? JSONDecoder().decode([WebShare].self, from: Data(json.utf8))) ?? []
    }

    private var sessions: [HostedSession] {
      let json = """
        [{"id":"h-1","client":{"id":"h-0f3e","name":"studio"},"platform":"ios","device":"iPhone 17 Pro","app":"Example",
          "state":"ready","parked":false,"since":"\(iso(-1_260))","workspace":"feature-search"}]
        """
      return (try? JSONDecoder().decode([HostedSession].self, from: Data(json.utf8))) ?? []
    }

    private static let floco = PairedServer(
      endpoint: URL(string: "wss://floco.tail1234.ts.net:7443")!, name: "floco", serverKey: Data(repeating: 7, count: 32),
      clientKey: Data(repeating: 9, count: 32), serverID: "floco-id", capabilities: ["read", "control"],
      pairedAt: Date(timeIntervalSince1970: 1_791_200_000), deviceID: "d-4f2a")

    private static let mini = PairedServer(
      endpoint: URL(string: "wss://mini.tail1234.ts.net:7443")!, name: "mini", serverKey: Data(repeating: 3, count: 32),
      clientKey: Data(repeating: 4, count: 32), serverID: "mini-id", capabilities: ["read"],
      pairedAt: Date(timeIntervalSince1970: 1_791_200_000), deviceID: "d-81c0")

    private var statuses: [BuildMachineStatus] {
      let json = """
        [{"machine":"mini","state":"approved","offloadable":true,"dnsName":"mini.tail1234.ts.net","deviceId":"a1b2c3d4",
          "capacity":{"running":0,"max":1,"diskFreeBytes":825196154880,"cpus":10,"loadPerCore":0.6,
                      "memoryUsedBytes":9663676416,"memoryTotalBytes":17179869184}},
         {"machine":"build-box","state":"key-unconfirmed","dnsName":"build-box.tail1234.ts.net"},
         {"machine":"studio","state":"outdated","dnsName":"studio.tail1234.ts.net","deviceId":"e5f6a7b8",
          "diagnosis":{"layer":"compat","code":"server-outdated","title":"Server is outdated",
            "message":"studio runs a stim-server older than this machine's Stim.",
            "remedy":"On studio, run stim-server service update --release 1.40.0."}}]
        """
      return (try? JSONDecoder().decode([BuildMachineStatus].self, from: Data(json.utf8))) ?? []
    }

    private var listing: RemoteMachineListing? {
      let json = """
        {"machines":[{"machine":"mini","serverKeyFingerprint":"\(Self.mini.id)","revoke":["stim-server devices revoke a1b2c3d4"]},
                     {"machine":"build-box","serverKeyFingerprint":null,"revoke":[]},
                     {"machine":"studio","serverKeyFingerprint":"other","revoke":["stim-server devices revoke e5f6a7b8"]}]}
        """
      return try? JSONDecoder().decode(RemoteMachineListing.self, from: Data(json.utf8))
    }

    var body: some View {
      VStack(spacing: 0) {
        Picker("Direction", selection: .constant(segment)) {
          Text("Using this machine").tag(ConnectionsSegment.incoming)
          Text("This machine uses").tag(ConnectionsSegment.outgoing)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
        .padding(.top, Space.xl)
        switch segment {
        case .incoming: incoming
        case .outgoing: outgoing
        }
      }
      .frame(width: 780, height: height)
      .background(Palette.background)
    }

    private var incoming: some View {
      IncomingConnectionsContent(
        allowsConnections: $allows, problem: nil, phoneApp: true,
        connections: Connections.incoming(devices), keepsAwake: $awake, shares: shares,
        workspaceTitle: { _ in "checkout" }, sessions: sessions, addPhone: {}, addMachine: {}, explain: { _ in }, fix: { _ in },
        setAccess: { _, _ in }, rename: { _ in }, revoke: { _ in }, stopShare: { _ in }, stopWorkspaceShares: { _ in },
        stopSession: { _ in },
        server: Text("stim-server 1.40.0 on port 7787").font(.stim(.footnote)).foregroundStyle(Palette.secondary))
    }

    private var outgoing: some View {
      let entries = ["mini", "build-box", "studio"]
      let paired = [
        PairedServers.Entry(id: Self.mini.id, kind: .pairing(Self.mini), connection: .open),
        PairedServers.Entry(id: Self.floco.id, kind: .pairing(Self.floco), connection: .open),
      ]
      let hosts = [BuildMachineStatus(machine: "mini", state: .approved)]
      return BuildMachinesContent(
        entries: entries, statuses: statuses,
        connections: Connections.outgoing(
          entries: entries, statuses: statuses, hosts: hosts, listing: listing, paired: paired),
        updates: [:], refreshing: false, tailscaleRunning: true, canAsk: true, addDisabled: false,
        updatesAutomatically: .constant(false), add: {}, ask: { _ in }, update: { _ in }, remove: { _ in },
        poolDisabled: ["build": [], "device": []], thisMachineName: "MacBook Pro", notices: EmptyView())
    }
  }
#endif
