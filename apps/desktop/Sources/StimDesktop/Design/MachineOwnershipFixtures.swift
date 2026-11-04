#if DEBUG
  import Foundation
  import StimKit
  import StimStores
  import SwiftUI

  struct MachineOwnershipPlayground: View {
    var now: Date

    private let groups = MachineChoices.groups(remote: ["mini:7443", "studio:7443"], paired: ["floco-key"])

    private func chip(_ choice: MachineChoice) -> MachineChip {
      switch choice {
      case .thisMachine: return MachineChip(title: MachineChoices.thisMachineName, subtitle: "Local", tone: nil)
      case .remote(let entry): return MachineChip(title: machineName(entry), subtitle: "Ready", tone: .success)
      case .paired: return MachineChip(title: "floco", subtitle: "Connected", tone: .success)
      }
    }

    private var placed: [PlacedWork] {
      let started = ISO8601DateFormatter().string(from: now.addingTimeInterval(-95))
      let json = """
        [{"path":"/Users/me/stim/.worktrees/issue-4980","live":true,"warnings":[],
          "ios":{"name":"stim-issue-4980 (iPhone 17 Pro 27.0)","udid":"","owned":false,"state":"ready",
                 "host":{"machine":"mini:7443","session":"s-ios"}},
          "build":{"platform":"android","slot":"default","state":"running","phase":"compile","startedAt":"\(started)",
                   "phaseStartedAt":"\(started)","basis":0,
                   "placement":{"host":"mini:7443","phase":"pods","startedAt":"\(started)","phaseStartedAt":"\(started)"}}}]
        """
      let workspaces = (try? JSONDecoder().decode([Workspace].self, from: Data(json.utf8))) ?? []
      return PlacedWork.list(workspaces.map { OwnedWorkspace(owner: .local, workspace: $0) })
    }

    private var sessions: [HostedSession] {
      let since = ISO8601DateFormatter().string(from: now.addingTimeInterval(-1500))
      let json = """
        [{"id":"h1","client":{"id":"c1","name":"build-box"},"platform":"ios","device":"iPhone 17 Pro","app":"Floco",
          "state":"ready","parked":false,"since":"\(since)","workspace":"/home/bot/app"},
         {"id":"h2","client":{"id":"c2","name":"janics-laptop"},"platform":"android","device":"Pixel 9","app":"Stim Mobile",
          "state":"preparing","parked":false,"since":"\(since)","workspace":"/Users/janic/stim"}]
        """
      return (try? JSONDecoder().decode([HostedSession].self, from: Data(json.utf8))) ?? []
    }

    private func bar(_ selection: MachineChoice) -> some View {
      MachineChoiceBar(groups: groups, selection: selection, chip: chip, select: { _ in })
    }

    var body: some View {
      ScrollView {
        VStack(alignment: .leading, spacing: Space.xxxl) {
          VStack(alignment: .leading, spacing: Space.xxl) {
            bar(.remote("mini:7443"))
            Divider()
            MachineHeading(icon: "desktopcomputer", title: "mini", subtitle: "Ready") { EmptyView() }
            PlacedWorkSection(machine: "mini", work: placed)
          }
          Divider()
          VStack(alignment: .leading, spacing: Space.xxl) {
            bar(.thisMachine)
            Divider()
            MachineHeading(icon: "laptopcomputer", title: "Janic's MacBook", subtitle: MachineChoices.thisMachineName) {
              EmptyView()
            }
            HostingSection(sessions: sessions, stopping: [], stop: { _ in })
          }
        }
        .padding(Space.xxl)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }
#endif
