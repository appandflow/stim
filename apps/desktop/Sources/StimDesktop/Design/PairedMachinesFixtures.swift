#if DEBUG
  import Foundation
  import StimKit
  import StimStores
  import SwiftUI

  struct PairedMachinesPlayground: View {
    var scenario: PlaygroundScenario
    var now: Date
    @StateObject private var state = PairedViewState()

    private static let pairing = PairedServer(
      endpoint: URL(string: "wss://floco.tail7f5754.ts.net:7443")!, name: "floco", serverKey: Data(repeating: 7, count: 32),
      clientKey: Data(repeating: 9, count: 32), serverID: "floco-id", capabilities: ["read"],
      pairedAt: Date(timeIntervalSince1970: 1_791_200_000))

    private var offline: Bool { scenario == .error }

    private var entry: PairedServers.Entry {
      PairedServers.Entry(
        id: Self.pairing.id, kind: .pairing(Self.pairing),
        connection: offline
          ? .offline(reason: "The machine stopped answering.", retryIn: 12, hadOpened: true) : .open)
    }

    private var status: PairedStatus {
      PairedStatus(payload: payload, updatedAt: now, delivering: !offline)
    }

    private var payload: StatusPayload? {
      let started = ISO8601DateFormatter().string(from: now.addingTimeInterval(-95))
      let phase = ISO8601DateFormatter().string(from: now.addingTimeInterval(-40))
      let json = #"""
        {"environments":[
          {"path":"/home/bot/work/app/.worktrees/fix-login","live":true,"warnings":[],
           "ios":{"name":"stim-fix-login (iPhone 17 Pro 27.0)","udid":"","owned":false,"state":"ready",
                  "host":{"machine":"janics-mac-mini-2:7443","session":"bot-ios-1",
                          "device":{"name":"iPhone 17 Pro","runtime":"iOS 27.0"}},
                  "activity":{"state":"driven","driver":{"tool":"Claude Code"},"basis":["driver"]}},
           "build":{"platform":"android","slot":"default","state":"running","phase":"compile","startedAt":"\#(started)",
                    "phaseStartedAt":"\#(phase)","basis":0,
                    "placement":{"host":"janics-mac-mini-2:7443","phase":"pods","startedAt":"\#(started)",
                                 "phaseStartedAt":"\#(phase)"}},
           "agents":[{"tool":"claude-code","sessionId":"a1","title":"Fix the login redirect","cwd":"/home/bot/work/app"}]},
          {"path":"/home/bot/work/app","live":false,"warnings":[]}
        ],
        "capacity":{"liveCount":1,"committedMb":2048,"totalMemoryMb":16384,"overCapacity":false,
                    "load":{"cpus":8,"loadPerCore":0.4,"busyAt":1.5,"state":"free"}}}
        """#
      guard var payload = try? JSONDecoder().decode(StatusPayload.self, from: Data(json.utf8)) else { return nil }
      for i in payload.environments.indices {
        payload.environments[i].project = Project(fallbackFor: payload.environments[i].path)
      }
      return payload
    }

    var body: some View {
      let key = WorkspaceKey(owner: .paired(Self.pairing.id), path: "/home/bot/work/app/.worktrees/fix-login")
      HStack(spacing: 0) {
        List {
          PairedSidebarSection(
            entry: entry, session: nil, status: status, options: SidebarOptions(),
            selection: .pairedWorkspace(key), state: state)
        }
        .frame(width: 300)
        .scrollContentBackground(.hidden)
        .background(Palette.sidebar)
        Divider()
        ScrollView {
          VStack(alignment: .leading, spacing: Space.xxl) {
            if let workspace = payload?.environments.first {
              PairedWorkspacePage(
                owned: OwnedWorkspace(owner: key.owner, workspace: workspace), serverName: "floco",
                connectionLine: offline
                  ? "Offline since \(now.addingTimeInterval(-300).formatted(date: .omitted, time: .shortened)). This is the last status floco reported."
                  : nil)
            }
            Divider()
            PairedMachineSection(
              entry: entry, session: nil, status: status,
              work: RemoteWork.list((payload?.environments ?? []).map { OwnedWorkspace(owner: key.owner, workspace: $0) })
            )
            .padding(.horizontal, Space.xxxl)
          }
        }
      }
    }
  }
#endif
