#if DEBUG
  import AppKit
  import StimKit
  import StimStores
  import SwiftUI

  struct ScreenPlaygroundApp: App {
    init() {
      BrandAssets.registerFonts()
      NSApp.setActivationPolicy(.regular)
    }

    var body: some Scene {
      Window("SwiftUI Playground", id: ComponentGallery.windowID) {
        ComponentGallery().onAppear { NSApp.activate(ignoringOtherApps: true) }
      }
      .defaultSize(width: 1100, height: 850)
    }
  }

  enum PlaygroundScreen: String, CaseIterable, Identifiable {
    case archivedSidebar = "Archived sidebar"
    case realArchiveSidebar = "Real archive sidebar"
    case realArchiveWorkspace = "Real archive workspace"
    case realArchiveBuildSheet = "Real archive build sheet"
    case workspace = "Workspace"
    case archivedWorkspace = "Archived workspace"
    case notifications = "Notifications"
    case builds = "Builds"
    case buildSheet = "Build sheet"
    case archivedBuildSheet = "Archived build sheet"
    case simulator = "Simulator controls"
    case hostedIos = "Hosted iOS"
    case hostedAndroid = "Hosted Android"
    case settings = "Settings"
    case addMachine = "Add build machine"
    case discovery = "Suggestions"
    case tokens = "Design tokens"
    var id: Self { self }

    var scenarios: [PlaygroundScenario] {
      switch self {
      case .archivedSidebar, .archivedBuildSheet, .realArchiveSidebar, .realArchiveWorkspace, .realArchiveBuildSheet:
        return [.ready]
      case .workspace, .archivedWorkspace: return [.ready, .empty, .error]
      case .notifications: return [.ready, .empty, .longText, .largeData]
      case .builds: return PlaygroundScenario.allCases
      case .buildSheet: return [.ready, .loading, .error, .longText, .largeData]
      case .hostedIos, .hostedAndroid: return [.ready, .loading, .error, .empty]
      case .simulator: return [.ready, .loading, .empty, .error]
      case .settings: return [.ready, .loading, .empty, .error, .longText]
      case .tokens, .addMachine, .discovery: return [.ready]
      }
    }
  }

  struct PlaygroundScreenView: View {
    var screen: PlaygroundScreen
    var scenario: PlaygroundScenario
    var fixtureDate = Date()
    @State private var fixtures: PlaygroundFixtures?
    @State private var failure: String?
    @State private var action = "All changes stay in memory."
    @State private var actions: ActionCenter?
    @State private var workspace: String? = PlaygroundFixtures.workspace
    @State private var scope = SettingScope.workspace

    var body: some View {
      VStack(spacing: 0) {
        if let fixtures, let actions {
          content(fixtures)
            .environmentObject(actions)
            .environmentObject(fixtures.checks)
            .environment(\.fixtureDate, fixtureDate)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let failure {
          EmptyState(title: "Fixture unavailable", message: failure)
        } else {
          ProgressView()
        }
        Divider()
        Text(action).font(.stim(.caption)).foregroundStyle(Palette.secondary)
          .frame(maxWidth: .infinity, alignment: .leading).padding(Space.md)
          .accessibilityIdentifier("playground.action")
      }
      .background(Palette.background)
      .onAppear {
        do {
          fixtures =
            try [.realArchiveSidebar, .realArchiveWorkspace, .realArchiveBuildSheet].contains(screen)
            ? PlaygroundFixtures.realArchive(now: fixtureDate) : PlaygroundFixtures.make(scenario, now: fixtureDate)
          actions = ActionCenter(fixtureAction: { action = "Simulated: \($0). No command was run." })
          if scenario == .empty { workspace = nil }
        } catch {
          failure = error.localizedDescription
        }
      }
    }

    private func workspacePage(_ fixtures: PlaygroundFixtures) -> WorkspaceDetail {
      let cli = Task { StimCLI(environment: [:]) }
      let reader = StatsReader(cli: cli, server: { nil })
      var view = WorkspaceDetail.archived(
        fixtures.archive, cli: cli, statsReader: reader, environments: [fixtures.environment])
      view.fixtureDate = fixtureDate
      view.fixtureDetail = scenario == .empty ? nil : fixtures.archiveDetail
      view.readsServer = false
      if screen == .workspace {
        view.archive = nil
        view.env =
          ArchivedPage(archive: fixtures.archive, detail: scenario == .empty ? nil : fixtures.archiveDetail, now: fixtureDate)
          .workspace
        view.page = WorktreePage.groups(environments: [view.env])[0]
      }
      return view
    }

    private func sidebarArchives(_ fixtures: PlaygroundFixtures) -> [ArchivedWorkspace] {
      if screen == .realArchiveSidebar { return [fixtures.archive] }
      var mobile = fixtures.archive
      mobile.projectRoot = "/Playground/stim/.worktrees/feature-search/apps/mobile"
      mobile.project = "mobile"
      mobile.worktree.repository = "/Playground/stim"
      var desktop = mobile
      desktop.id = "playground-desktop"
      desktop.projectRoot = "/Playground/stim/.worktrees/feature-search/apps/desktop"
      desktop.project = "desktop"
      var gone = mobile
      gone.id = "playground-gc"
      gone.projectRoot = "/Playground/.claude/worktrees/missing-facts/apps/mobile"
      gone.worktree.repository = nil
      gone.worktree.branch = nil
      gone.worktree.pullRequest?.state = "draft"
      gone.worktree.merged = nil
      return [mobile, desktop, gone]
    }

    private func scopeTitle(_ scope: SettingScope) -> String {
      switch scope {
      case .machine: return "Machine"
      case .repo: return "Repository"
      case .workspace: return "Workspace"
      case .committed: return ".stim.json"
      }
    }

    @ViewBuilder private func content(_ fixtures: PlaygroundFixtures) -> some View {
      switch screen {
      case .archivedSidebar, .realArchiveSidebar:
        List {
          let archives = sidebarArchives(fixtures)
          var options: SidebarOptions {
            var value = SidebarOptions()
            value.status = .archived
            return value
          }
          let trees = sidebarTrees(
            environments: [], unprovisioned: [], project: { Project(fallbackFor: $0) },
            options: options, archived: archives)
          ForEach(trees, id: \.summary.project) { tree in
            DisclosureGroup(tree.summary.project.name, isExpanded: .constant(true)) {
              ForEach(tree.entries) { entry in
                EntryRow(entry: entry, subtitle: nil, showsFolder: true, showsGit: true, selection: nil, openLogs: { _ in })
              }
            }
          }
        }.scrollContentBackground(.hidden).background(Palette.sidebar)
      case .workspace, .archivedWorkspace, .realArchiveWorkspace:
        workspacePage(fixtures)
      case .notifications:
        InboxView(inbox: fixtures.inbox) { _ in action = "Selected notification logs (fixture only)." }
      case .builds:
        ScrollView {
          BuildSection(
            cli: Task { StimCLI(environment: [:]) }, env: fixtures.environment,
            openLogs: { _ in action = "Selected build logs (fixture only)." },
            openBuild: { _ in action = "Selected build details (fixture only)." }
          )
          .padding(Space.xl)
        }
      case .buildSheet:
        BuildSheet(
          cli: Task { StimCLI(environment: ProcessInfo.processInfo.environment) }, env: fixtures.environment,
          selection: BuildSheetSelection(workspace: fixtures.environment.path, platform: "ios"),
          openLogs: { _ in action = "Selected build logs panel (fixture only)." }, readsServer: false)
      case .archivedBuildSheet, .realArchiveBuildSheet:
        let adapted = ArchivedPage(archive: fixtures.archive, detail: fixtures.archiveDetail, now: fixtureDate)
        BuildSheet(
          cli: Task { StimCLI(environment: [:]) }, env: adapted.workspace,
          selection: BuildSheetSelection(workspace: adapted.workspace.path, platform: "ios"),
          openLogs: { _ in action = "Selected archived build logs (fixture only)." }, archive: fixtures.archive,
          logsExpired: adapted.logsExpired, readsServer: false)
      case .hostedIos:
        HostedDeviceGallery(scenario: scenario, platform: "ios")
      case .hostedAndroid:
        HostedDeviceGallery(scenario: scenario, platform: "android")
      case .simulator:
        ScrollView {
          SimulatorOptionsView(fixture: PlaygroundSimulator(scenario: scenario))
            .padding(Space.xl)
        }
      case .settings:
        TabView(selection: $scope) {
          ForEach([SettingScope.machine, .repo, .workspace, .committed], id: \.self) { scope in
            ScopeSettingsView(
              scope: scope, model: fixtures.settings, workspace: $workspace,
              workspaces: [PlaygroundFixtures.workspace], title: { _ in "feature-search" }
            )
            .tabItem { Text(scopeTitle(scope)) }.tag(scope)
          }
        }
        .padding(Space.md)
      case .discovery:
        DiscoveryPlayground()
      case .addMachine:
        AddMachinePlayground()
      case .tokens:
        EmptyView()
      }
    }
  }
  extension EnvironmentValues {
    @Entry var fixtureDate: Date? = nil
  }
#endif
