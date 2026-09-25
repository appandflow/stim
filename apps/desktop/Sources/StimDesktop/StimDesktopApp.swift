import AppKit
import SimulatorFrames
import StimKit
import SwiftUI

@MainActor
final class OpenRequests: ObservableObject {
  static let shared = OpenRequests()
  @Published var simulatorUdid: String?
  @Published var workspacePath: String?
  /// The workspace selected in the main window, which the Settings window edits.
  @Published var selectedWorkspace: String?
  @Published var showsStorage = false
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var terminationSource: DispatchSourceSignal?

  func application(_ application: NSApplication, open urls: [URL]) {
    guard let udid = urls.lazy.compactMap(simulatorUdid(fromOpenURL:)).last else { return }
    MainActor.assumeIsolated { OpenRequests.shared.simulatorUdid = udid }
  }

  func applicationWillFinishLaunching(_ notification: Notification) {
    MainActor.assumeIsolated { NotificationResponder.shared.install() }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // `swift run` starts a bare executable as a background process with no Dock icon or focus.
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
    // AppKit exits on SIGTERM without calling applicationWillTerminate, which would orphan stim-server.
    signal(SIGTERM, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    source.setEventHandler {
      MainActor.assumeIsolated { ServerController.shared.stopForQuit() }
      exit(0)
    }
    source.resume()
    terminationSource = source
    MainActor.assumeIsolated {
      Theme.apply(Appearance(rawValue: UserDefaults.standard.string(forKey: AppPreferences.Key.appearance) ?? "") ?? .auto)
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    MainActor.assumeIsolated { ServerController.shared.stopForQuit() }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    !UserDefaults.standard.bool(forKey: AppPreferences.Key.showsMenuBarExtra)
  }
}

@main
struct StimDesktopApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @StateObject private var store: StatusStore
  @StateObject private var notifier: Notifier
  @StateObject private var actions: ActionCenter
  @StateObject private var autopilot: AutopilotRunner
  @AppStorage(AppPreferences.Key.showsMenuBarExtra) private var showsMenuBarExtra = false
  private let cli: Task<StimCLI, Never>

  init() {
    BrandAssets.registerFonts()
    UserDefaults.standard.register(defaults: AppPreferences.defaults)
    AppPreferences.migrate(.standard)
    CoreSimulator.developerDir = CoreSimulator.selectedDeveloperDir()
    let override = UserDefaults.standard.string(forKey: AppPreferences.Key.stimExecutable)
    let environment = Task.detached { await LoginShell.environment() ?? ProcessInfo.processInfo.environment }
    let cli = Task.detached { StimCLI(environment: await environment.value, override: override) }
    self.cli = cli
    ServerController.shared.configure(environment: environment)
    let store = StatusStore(cli: cli)
    _store = StateObject(wrappedValue: store)
    _notifier = StateObject(wrappedValue: Notifier(store: store))
    let actions = ActionCenter(cli: cli)
    _actions = StateObject(wrappedValue: actions)
    let autopilot = AutopilotRunner(status: store, actions: actions, cli: cli)
    _autopilot = StateObject(wrappedValue: autopilot)
    DispatchQueue.main.async {
      store.start()
      autopilot.start()
    }
  }

  var body: some Scene {
    WindowGroup("Stim", id: "main") {
      RootView(cli: cli, store: store, actions: actions, autopilot: autopilot)
        .frame(minWidth: 700, minHeight: 720)
        .onAppear { notifier.start() }
    }
    .windowToolbarStyle(.unified(showsTitle: false))
    .handlesExternalEvents(matching: [])
    .commands {
      SidebarCommands()
      InspectorCommands()
    }

    Settings {
      SettingsView(cli: cli, store: store).environmentObject(autopilot)
    }

    MenuBarExtra(isInserted: $showsMenuBarExtra) {
      MenuBarContent(store: store)
    } label: {
      let live = store.payload?.environments.filter(\.live).count ?? 0
      Label("\(live)", systemImage: "iphone.gen3")
        .labelStyle(.titleAndIcon)
    }
  }
}

struct InspectorCommands: Commands {
  @FocusedValue(\.inspectorToggle) private var inspector

  var body: some Commands {
    CommandGroup(after: .sidebar) {
      Button(inspector?.isShown == true ? "Hide Inspector" : "Show Inspector") { inspector?.toggle() }
        .keyboardShortcut("i", modifiers: [.command, .option])
        .disabled(inspector == nil)
    }
  }
}
