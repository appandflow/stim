import AppKit
import SimulatorFrames
import StimKit
import SwiftUI

@MainActor
final class OpenRequests: ObservableObject {
  static let shared = OpenRequests()
  @Published var device: DeviceOpenRequest?
  @Published var workspaceLink: WorkspaceLink?
  @Published var workspacePath: String?
  /// The workspace selected in the main window, which the Settings window edits.
  @Published var selectedWorkspace: String?
  @Published var showsMachine = false
  @Published var pairsPhone = false
  @Published var target: OversightTarget?
  var openMainWindow: (() -> Void)?
}

extension Notification.Name {
  /// Posted when a quit is waiting on the sheets attached to a window.
  static let stimQuitRequested = Notification.Name("stimQuitRequested")
}

extension View {
  /// Runs `dismiss` when a quit is requested, for the state that presents a sheet.
  func onQuitRequested(_ dismiss: @escaping () -> Void) -> some View {
    onReceive(NotificationCenter.default.publisher(for: .stimQuitRequested)) { _ in dismiss() }
  }
}

/// AppKit refuses `terminate:` while a window has an attached sheet, such as the device viewer. The sheets are
/// dismissed through the state that presents them, which tears down the viewer and releases a device it took over,
/// and the quit retries until none is attached. AppKit's own quit Apple Event handler fails with "User cancelled
/// (-128)" without calling `terminate:`, so `AppDelegate` handles that event itself.
final class StimApplication: NSApplication {
  private var sheetRetries = 0

  override func terminate(_ sender: Any?) {
    guard windows.contains(where: { $0.attachedSheet != nil }), sheetRetries < 20 else {
      sheetRetries = 0
      super.terminate(sender)
      return
    }
    sheetRetries += 1
    NotificationCenter.default.post(name: .stimQuitRequested, object: nil)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.terminate(sender) }
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var terminationSource: DispatchSourceSignal?

  func application(_ application: NSApplication, open urls: [URL]) {
    if let link = urls.lazy.compactMap(workspaceLink(fromOpenURL:)).last {
      MainActor.assumeIsolated {
        OpenRequests.shared.workspaceLink = link
        NSApp.windows.first { $0.identifier?.rawValue.hasPrefix("main") == true }?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
      }
    }
    guard let request = urls.lazy.compactMap(deviceOpenRequest(fromOpenURL:)).last else { return }
    MainActor.assumeIsolated { OpenRequests.shared.device = request }
  }

  func applicationWillFinishLaunching(_ notification: Notification) {
    NSAppleEventManager.shared().setEventHandler(
      self, andSelector: #selector(handleQuitEvent(_:withReplyEvent:)),
      forEventClass: AEEventClass(kCoreEventClass), andEventID: AEEventID(kAEQuitApplication))
    MainActor.assumeIsolated { NotificationResponder.shared.install() }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // `swift run` starts a bare executable as a background process with no Dock icon or focus.
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
    // AppKit exits on SIGTERM without posting willTerminateNotification, which would orphan stim-server
    // and the stim children the stores stop from that notification.
    signal(SIGTERM, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    source.setEventHandler {
      MainActor.assumeIsolated { NSApp.terminate(nil) }
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
        LogFollower.stopAll()
        MainActor.assumeIsolated { ServerController.shared.stopForQuit() }
        exit(0)
      }
    }
    source.resume()
    terminationSource = source
    MainActor.assumeIsolated {
      _ = AppUpdater.shared
      Theme.apply(Appearance(rawValue: UserDefaults.standard.string(forKey: AppPreferences.Key.appearance) ?? "") ?? .auto)
    }
  }

  @objc private func handleQuitEvent(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
    NSApp.terminate(nil)
  }

  func applicationWillTerminate(_ notification: Notification) {
    LogFollower.stopAll()
    MainActor.assumeIsolated { ServerController.shared.stopForQuit() }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    !UserDefaults.standard.bool(forKey: AppPreferences.Key.showsMenuBarExtra)
  }
}

struct StimDesktopApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @StateObject private var store: StatusStore
  @StateObject private var notifier: Notifier
  @StateObject private var oversight: OversightNotifier
  @StateObject private var actions: ActionCenter
  @StateObject private var autopilot: AutopilotRunner
  @StateObject private var onboarding: Onboarding
  @StateObject private var gc: GcReportStore
  @AppStorage(AppPreferences.Key.showsMenuBarExtra) private var showsMenuBarExtra = false
  private let cli: Task<StimCLI, Never>

  init() {
    CrashReporter.start()
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
    BuildRequestNotifier.shared.start()
    _ = ServerSession.shared
    let store = StatusStore(cli: cli)
    _store = StateObject(wrappedValue: store)
    _notifier = StateObject(wrappedValue: Notifier(store: store))
    let oversight = OversightNotifier(store: store)
    _oversight = StateObject(wrappedValue: oversight)
    let actions = ActionCenter(cli: cli)
    _actions = StateObject(wrappedValue: actions)
    let gc = GcReportStore(cli: cli)
    _gc = StateObject(wrappedValue: gc)
    actions.onFinish = { [store, gc] run in
      let worktree = run.steps.contains { $0.program == "stim" && $0.arguments.first == "worktree" }
      if !store.watching || worktree { store.refresh() }
      if run.steps.contains(where: GcReport.changed(by:)) { gc.changed() }
      for step in run.steps where step.arguments.first == "doctor" && step.arguments.contains("--fix") {
        store.doctorChanged(in: step.cwd)
      }
    }
    let autopilot = AutopilotRunner(status: store, actions: actions, gc: gc, cli: cli)
    _autopilot = StateObject(wrappedValue: autopilot)
    let onboarding = Onboarding(environment: environment, cli: cli, actions: actions)
    _onboarding = StateObject(wrappedValue: onboarding)
    DispatchQueue.main.async {
      store.start()
      oversight.start()
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

    #if DEBUG
      Window("Component Gallery", id: ComponentGallery.windowID) { ComponentGallery() }
    #endif

    Settings {
      SettingsView(cli: cli, store: store).environmentObject(autopilot)
    }

    MenuBarExtra(isInserted: menuBarExtraInserted) {
      MenuBarContent(store: store)
    } label: {
      let live = store.payload?.environments.filter(\.live).count ?? 0
      Label("\(live)", systemImage: "iphone.gen3")
        .labelStyle(.titleAndIcon)
    }
  }

  // SwiftUI's MenuBarExtra writes its status item's visibility back to `isInserted` on every app graph update, and
  // an @AppStorage write posts UserDefaults.didChangeNotification even when the value is unchanged, which updates
  // every @AppStorage view and so the app graph again.
  private var menuBarExtraInserted: Binding<Bool> {
    Binding(
      get: { showsMenuBarExtra },
      set: { if $0 != showsMenuBarExtra { showsMenuBarExtra = $0 } })
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
