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
    case notifications = "Notifications"
    case builds = "Builds"
    case buildSheet = "Build sheet"
    case simulator = "Simulator controls"
    case hostedIos = "Hosted iOS"
    case settings = "Settings"
    case tokens = "Design tokens"
    var id: Self { self }

    var scenarios: [PlaygroundScenario] {
      switch self {
      case .notifications: return [.ready, .empty, .longText, .largeData]
      case .builds: return PlaygroundScenario.allCases
      case .buildSheet: return [.ready, .loading, .error, .longText, .largeData]
      case .hostedIos: return [.ready, .loading, .error, .empty]
      case .simulator: return [.ready, .loading, .empty, .error]
      case .settings: return [.ready, .loading, .empty, .error, .longText]
      case .tokens: return [.ready]
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
          fixtures = try PlaygroundFixtures.make(scenario, now: fixtureDate)
          actions = ActionCenter(fixtureAction: { action = "Simulated: \($0). No command was run." })
          if scenario == .empty { workspace = nil }
        } catch {
          failure = error.localizedDescription
        }
      }
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
          openLogs: { _ in action = "Selected build logs panel (fixture only)." })
      case .hostedIos:
        HostedIosGallery(scenario: scenario)
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
      case .tokens:
        EmptyView()
      }
    }
  }
#endif
