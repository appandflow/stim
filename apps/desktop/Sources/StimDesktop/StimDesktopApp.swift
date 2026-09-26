import AppKit
import SimulatorFrames
import StimKit
import SwiftUI

@MainActor
final class OpenRequests: ObservableObject {
  static let shared = OpenRequests()
  @Published var device: DeviceOpenRequest?
  @Published var workspacePath: String?
  /// The workspace selected in the main window, which the Settings window edits.
  @Published var selectedWorkspace: String?
  @Published var showsMachine = false
  @Published var pairsPhone = false
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var terminationSource: DispatchSourceSignal?

  func application(_ application: NSApplication, open urls: [URL]) {
    guard let request = urls.lazy.compactMap(deviceOpenRequest(fromOpenURL:)).last else { return }
    MainActor.assumeIsolated { OpenRequests.shared.device = request }
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
      _ = AppUpdater.shared
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
  @StateObject private var onboarding: Onboarding
  @StateObject private var gc: GcReportStore
  @AppStorage(AppPreferences.Key.showsMenuBarExtra) private var showsMenuBarExtra = false
  private let cli: Task<StimCLI, Never>

  init() {
    BrandAssets.registerFonts()
    UserDefaults.standard.register(defaults: AppPreferences.defaults)
    AppPreferences.migrate(.standard)
    CoreSimulator.developerDir = CoreSimulator.selectedDeveloperDir()
    let override = UserDefaults.standard.string(forKey: AppPreferences.Key.stimExecutable)
    let environment = Task.detached {
      var environment = await LoginShell.environment() ?? LoginShell.fallback(ProcessInfo.processInfo.environment)
      if Bundle.main.bundleURL.pathExtension == "app" { environment["STIM_DESKTOP_APP"] = Bundle.main.bundlePath }
      return environment
    }
    let cli = Task.detached { StimCLI(environment: await environment.value, override: override) }
    self.cli = cli
    ServerController.shared.configure(environment: environment)
    let store = StatusStore(cli: cli)
    _store = StateObject(wrappedValue: store)
    _notifier = StateObject(wrappedValue: Notifier(store: store))
    let actions = ActionCenter(cli: cli)
    _actions = StateObject(wrappedValue: actions)
    let gc = GcReportStore(cli: cli)
    _gc = StateObject(wrappedValue: gc)
    let autopilot = AutopilotRunner(status: store, actions: actions, gc: gc, cli: cli)
    _autopilot = StateObject(wrappedValue: autopilot)
    let onboarding = Onboarding(environment: environment, cli: cli, actions: actions)
    _onboarding = StateObject(wrappedValue: onboarding)
    DispatchQueue.main.async {
      store.start()
      autopilot.start()
      onboarding.check()
    }
  }

  var body: some Scene {
    WindowGroup("Stim", id: "main") {
      RootView(cli: cli, store: store, actions: actions, autopilot: autopilot, onboarding: onboarding, gc: gc)
        .frame(minWidth: 700, minHeight: 720)
        .onAppear { notifier.start() }
    }
    .windowToolbarStyle(.unified(showsTitle: false))
    .handlesExternalEvents(matching: [])
    .commands {
      UpdateCommands()
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

struct UpdateCommands: Commands {
  @ObservedObject private var updater = AppUpdater.shared

  var body: some Commands {
    CommandGroup(after: .appInfo) {
      Button("Check for Updates\u{2026}") { updater.checkForUpdates() }
        .disabled(!updater.canCheckForUpdates)
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
