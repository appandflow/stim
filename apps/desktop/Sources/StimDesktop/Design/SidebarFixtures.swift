#if DEBUG
  import Foundation
  import StimKit
  import StimStores
  import SwiftUI

  struct SidebarPlayground: View {
    var now: Date
    @StateObject private var state = PairedViewState()
    @State private var local: StatusStore?
    @State private var metrics: MetricsStore?
    @State private var selection: SidebarItem? = Self.initialSelection
    @State private var updatedGitSummaries = false
    @State private var changedRowHeight = false
    @State private var hideLocalProjects = false
    @State private var autoUpdate = false
    @State private var autoSelect = false

    private static let initialSelectedPath =
      "/home/bot/work/savemyschoolwork-app/.worktrees/issue-1234-fix-dark-mode-appearances"
    private static var initialSelection: SidebarItem {
      .pairedWorkspace(WorkspaceKey(owner: .paired(pairing.id), path: initialSelectedPath))
    }
    private static let rowSelections: [SidebarItem] = [
      initialSelectedPath,
      "/home/bot/work/savemyschoolwork-app/.worktrees/issue-1301-onboarding-copy",
      "/home/bot/work/savemyschoolwork-app",
      "/home/bot/work/savemyschoolwork-app/.worktrees/issue-1188-old-spike",
    ].map { .pairedWorkspace(WorkspaceKey(owner: .paired(pairing.id), path: $0)) }

    private var selectedName: String {
      guard case .pairedWorkspace(let key) = selection else { return "none" }
      return URL(fileURLWithPath: key.path).lastPathComponent
    }

    private static let pairing = PairedServer(
      endpoint: URL(string: "wss://floco.tail7f5754.ts.net:7443")!, name: "floco", serverKey: Data(repeating: 7, count: 32),
      clientKey: Data(repeating: 9, count: 32), serverID: "floco-id", capabilities: ["read", "control"],
      pairedAt: Date(timeIntervalSince1970: 1_791_200_000), deviceID: "d-4f2a")

    private var entry: PairedServers.Entry {
      PairedServers.Entry(id: Self.pairing.id, kind: .pairing(Self.pairing), connection: .open)
    }

    private func environment(
      _ path: String, branch: String, live: Bool = false, building: Bool = false, session: String? = nil, pull: Int? = nil,
      changed: Int = 0, ahead: Int = 1, behind: Int = 0,
      hostedOn: String? = nil
    ) -> String {
      let started = ISO8601DateFormatter().string(from: now.addingTimeInterval(-95))
      let repository = path.components(separatedBy: "/.worktrees/")[0]
      let chip = [
        #"{"kind":"arrows","ahead":\#(ahead),"behind":\#(behind)}"#,
        changed > 0 ? #"{"kind":"changed","count":\#(changed)}"# : nil,
      ]
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
        {"path":"\#(path)","live":\#(live || building || session != nil),"warnings":[],
         "worktree":{"path":"\#(path)","branch":"\#(branch)","repository":"\#(repository)",
                     "git":{"changed":\#(changed),"untracked":0,"upstream":"origin/\#(branch)","ahead":\#(ahead),"behind":\#(behind)},
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
        environment(
          "/home/bot/work/savemyschoolwork-app", branch: "main", live: true,
          session: changedRowHeight ? "Run the main workspace" : nil, changed: 3, ahead: 0),
        environment(
          Self.initialSelectedPath, branch: "fix/1234-dark-mode-appearances", live: true,
          session: changedRowHeight ? "Investigate the selected row" : nil,
          pull: updatedGitSummaries ? nil : 1235,
          changed: updatedGitSummaries ? 2 : 14, ahead: updatedGitSummaries ? 0 : 1234,
          behind: updatedGitSummaries ? 0 : 5678, hostedOn: "mini-2:7443"),
        environment(
          "/home/bot/work/savemyschoolwork-app/.worktrees/issue-1301-onboarding-copy",
          branch: "fix/1301-onboarding-copy", live: true, session: changedRowHeight ? nil : "Onboarding copy", pull: 1302,
          changed: updatedGitSummaries ? 0 : 14, ahead: updatedGitSummaries ? 1 : 0, behind: 1),
        environment(
          "/home/bot/work/savemyschoolwork-app/.worktrees/issue-1188-old-spike", branch: "spike/1188", live: true,
          session: changedRowHeight ? "Revisit the spike" : nil, changed: 1, ahead: 0),
      ])
    }

    private var controls: some View {
      VStack(alignment: .leading, spacing: Space.sm) {
        HStack {
          Button("Update git summaries") { updatedGitSummaries.toggle() }
            .accessibilityIdentifier("sidebar-playground-update-git-summaries")
          Button("Change row height") { changedRowHeight.toggle() }
            .accessibilityIdentifier("sidebar-playground-change-row-height")
          Toggle("Hide local projects", isOn: $hideLocalProjects)
            .accessibilityIdentifier("sidebar-playground-hide-local")
          Toggle("Auto update", isOn: $autoUpdate)
            .accessibilityIdentifier("sidebar-playground-auto-update")
          Button("Reset") {
            autoUpdate = false
            autoSelect = false
            updatedGitSummaries = false
            changedRowHeight = false
            hideLocalProjects = false
            selection = Self.initialSelection
            state.hidden = []
            state.expandedProjects = [:]
            state.collapsedServers = []
          }
          .accessibilityIdentifier("sidebar-playground-reset")
        }
        HStack {
          ForEach(Self.rowSelections.indices, id: \.self) { index in
            Button("Select row \(index + 1)") { selection = Self.rowSelections[index] }
              .accessibilityIdentifier("sidebar-playground-select-\(index + 1)")
          }
          Toggle("Auto select", isOn: $autoSelect)
            .accessibilityIdentifier("sidebar-playground-auto-select")
        }
        Text(
          verbatim:
            "git=\(updatedGitSummaries ? "B" : "A") height=\(changedRowHeight) hideLocal=\(hideLocalProjects) auto=\(autoUpdate) selected=\(selectedName) | ids: \((pairedPayload?.environments.map(\.path) ?? []).joined(separator: ", "))"
        )
        .font(.system(size: 10, design: .monospaced))
        .accessibilityIdentifier("sidebar-playground-state")
      }
      .padding(Space.md)
    }

    private func sidebar(_ store: StatusStore, width: CGFloat) -> some View {
      let options = SidebarOptions()
      let paired = PairedStatus(payload: pairedPayload, updatedAt: now, delivering: true)
      return List(selection: $selection) {
        if !hideLocalProjects {
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
        }
        PairedSidebarSection(entry: entry, session: nil, status: paired, options: options, selection: selection, state: state)
      }
      .listStyle(.sidebar)
      .frame(width: width)
      .scrollContentBackground(.hidden)
      .background(Palette.sidebar)
    }

    var body: some View {
      VStack(alignment: .leading, spacing: 0) {
        controls
        HStack(alignment: .top, spacing: 0) {
          if let local {
            if case .pairedProject(_, let project) = selection, let metrics, let pairedPayload {
              sidebar(local, width: SidebarWidthGuard.ideal)
              Divider()
              PairedProjectPage(
                store: local, metrics: metrics,
                machine: PairedMachine(
                  id: Self.pairing.id, name: "floco", canControl: true, isAvailable: true,
                  workspaces: pairedPayload.environments),
                project: project, selection: $selection, openLogs: { _ in }, openDevice: { _, _ in }
              )
              .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
              ForEach([SidebarWidthGuard.minimum, SidebarWidthGuard.ideal, 360], id: \.self) { width in
                sidebar(local, width: width)
                Divider()
              }
            }
          }
        }
      }
      .task(id: autoUpdate) {
        guard autoUpdate else { return }
        var updatesGit = true
        while !Task.isCancelled {
          do {
            try await Task.sleep(for: .milliseconds(500))
          } catch {
            return
          }
          guard !Task.isCancelled, autoUpdate else { return }
          if updatesGit { updatedGitSummaries.toggle() } else { changedRowHeight.toggle() }
          updatesGit.toggle()
        }
      }
      .task(id: autoSelect) {
        guard autoSelect else { return }
        while !Task.isCancelled {
          do {
            try await Task.sleep(for: .milliseconds(1500))
          } catch {
            return
          }
          guard !Task.isCancelled, autoSelect else { return }
          let index = selection.flatMap { Self.rowSelections.firstIndex(of: $0) } ?? -1
          selection = Self.rowSelections[(index + 1) % Self.rowSelections.count]
        }
      }
      .onDisappear {
        autoUpdate = false
        autoSelect = false
      }
      .onAppear {
        guard local == nil, let payload = localPayload else { return }
        let status = StatusStore(fixture: payload)
        let report = try! JSONDecoder().decode(GcReport.self, from: Data(#"{"sections":{}}"#.utf8))
        let gc = GcReportStore(fixture: report)
        local = status
        metrics = MetricsStore(status: status, gc: gc, disks: DiskVolumeStore(status: status))
      }
    }
  }
#endif
