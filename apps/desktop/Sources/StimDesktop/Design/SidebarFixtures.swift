#if DEBUG
  import Foundation
  import StimKit
  import StimStores
  import SwiftUI

  struct SidebarPlayground: View {
    var now: Date
    @StateObject private var state = PairedViewState()
    @State private var local: StatusStore?
    @State private var selection: SidebarItem? = .pairedWorkspace(
      WorkspaceKey(
        owner: .paired(Self.pairing.id),
        path: "/home/bot/work/savemyschoolwork-app/.worktrees/issue-1234-fix-dark-mode-appearances"))

    private static let pairing = PairedServer(
      endpoint: URL(string: "wss://floco.tail7f5754.ts.net:7443")!, name: "floco", serverKey: Data(repeating: 7, count: 32),
      clientKey: Data(repeating: 9, count: 32), serverID: "floco-id", capabilities: ["read", "control"],
      pairedAt: Date(timeIntervalSince1970: 1_791_200_000), deviceID: "d-4f2a")

    private var entry: PairedServers.Entry {
      PairedServers.Entry(id: Self.pairing.id, kind: .pairing(Self.pairing), connection: .open)
    }

    private func environment(
      _ path: String, branch: String, building: Bool = false, session: String? = nil, pull: Int? = nil, changed: Int = 0,
      hostedOn: String? = nil
    ) -> String {
      let started = ISO8601DateFormatter().string(from: now.addingTimeInterval(-95))
      let repository = path.components(separatedBy: "/.worktrees/")[0]
      let chip = [#"{"kind":"arrows","ahead":1,"behind":0}"#, changed > 0 ? #"{"kind":"changed","count":\#(changed)}"# : nil]
        .compactMap { $0 }.joined(separator: ",")
      let request =
        pull.map {
          #","pullRequest":{"number":\#($0),"url":"https://example.invalid/pull/\#($0)","title":"A change","state":"open","checks":{"passing":4,"failing":0,"pending":0}}"#
        } ?? ""
      let build =
        building
        ? #","stage":{"kind":"building","platform":"ios","since":"\#(started)","closedApps":[]},"build":{"platform":"ios","slot":"default","state":"running","phase":"compile","startedAt":"\#(started)","phaseStartedAt":"\#(started)","basis":0}"#
        : ""
      let agents =
        session.map { #","agents":[{"tool":"codex","sessionId":"\#(branch)","title":"\#($0)","cwd":"\#(path)"}]"# } ?? ""
      let ios =
        hostedOn.map {
          #","ios":{"name":"stim-app (iPhone 17 Pro 27.0)","udid":"","owned":false,"state":"ready","host":{"machine":"\#($0)","session":"\#(branch)"}}"#
        } ?? ""
      return #"""
        {"path":"\#(path)","live":\#(building || session != nil),"warnings":[],
         "worktree":{"path":"\#(path)","branch":"\#(branch)","repository":"\#(repository)",
                     "git":{"changed":\#(changed),"untracked":0,"upstream":"origin/\#(branch)","ahead":1,"behind":0},
                     "gitChip":{"parts":[\#(chip)],"ci":"passing"}\#(request)}\#(build)\#(agents)\#(ios)}
        """#
    }

    private func payload(_ environments: [String]) -> StatusPayload? {
      let json = #"{"environments":[\#(environments.joined(separator: ","))]}"#
      guard var payload = try? JSONDecoder().decode(StatusPayload.self, from: Data(json.utf8)) else { return nil }
      for i in payload.environments.indices {
        payload.environments[i].project = Project(fallbackFor: payload.environments[i].path)
      }
      return payload
    }

    private var localPayload: StatusPayload? {
      payload([
        environment(
          "/Playground/stim/.worktrees/issue-4980-sidebar-rows", branch: "fix/4980-sidebar-rows",
          session: "Fix the sidebar rows", pull: 4981, changed: 2,
          hostedOn: "mini:7443"),
        environment(
          "/Playground/stim/.worktrees/issue-4666-project-heading-overlaps-expanded-worktree-rows", branch: "fix/4666",
          building: true, session: "Investigate the overlap", pull: 4667, changed: 5),
        environment(
          "/Playground/stim/.worktrees/issue-1234-appearances", branch: "fix/1234", session: "Appearances", pull: 4670),
        environment("/Playground/savemyschoolwork-app", branch: "main", building: true),
        environment("/Playground/savemyschoolwork-app/.worktrees/idle", branch: "idle"),
      ])
    }

    private var pairedPayload: StatusPayload? {
      payload([
        environment("/home/bot/work/appandflow-template", branch: "main"),
        environment("/home/bot/work/savemyschoolwork-app", branch: "main"),
        environment(
          "/home/bot/work/savemyschoolwork-app/.worktrees/issue-1234-fix-dark-mode-appearances",
          branch: "fix/1234-dark-mode-appearances", building: true, changed: 2, hostedOn: "mini-2:7443"),
      ])
    }

    private func sidebar(_ store: StatusStore, width: CGFloat) -> some View {
      let options = SidebarOptions()
      let paired = PairedStatus(payload: pairedPayload, updatedAt: now, delivering: true)
      return List(selection: $selection) {
        Section {
          ForEach(store.sidebarTrees(options), id: \.summary.project) { tree in
            DisclosureGroup(isExpanded: .constant(true)) {
              ForEach(tree.entries) { entry in
                EntryRow(
                  entry: entry, subtitle: nil, showsFolder: false, showsGit: true, selection: selection, openLogs: { _ in })
              }
            } label: {
              ProjectRow(store: store, summary: tree.summary, selected: false)
                .sidebarTag(.project(tree.summary.project), selection: selection)
            }
          }
        } header: {
          SectionLabel(title: "Projects").background(PlainSelectionHighlight())
        }
        PairedSidebarSection(entry: entry, session: nil, status: paired, options: options, selection: selection, state: state)
      }
      .listStyle(.sidebar)
      .frame(width: width)
      .scrollContentBackground(.hidden)
      .background(Palette.sidebar)
    }

    var body: some View {
      HStack(alignment: .top, spacing: 0) {
        if let local {
          ForEach([SidebarWidthGuard.minimum, SidebarWidthGuard.ideal, 360], id: \.self) { width in
            sidebar(local, width: width)
            Divider()
          }
        }
      }
      .onAppear {
        guard local == nil, let payload = localPayload else { return }
        local = StatusStore(fixture: payload)
      }
    }
  }
#endif
