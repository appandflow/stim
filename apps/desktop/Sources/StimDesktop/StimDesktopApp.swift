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
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  func application(_ application: NSApplication, open urls: [URL]) {
    guard let udid = urls.lazy.compactMap(simulatorUdid(fromOpenURL:)).last else { return }
    MainActor.assumeIsolated { OpenRequests.shared.simulatorUdid = udid }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // `swift run` starts a bare executable as a background process with no Dock icon or focus.
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
    MainActor.assumeIsolated {
      Theme.apply(Appearance(rawValue: UserDefaults.standard.string(forKey: AppPreferences.Key.appearance) ?? "") ?? .auto)
    }
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
  @AppStorage(AppPreferences.Key.showsMenuBarExtra) private var showsMenuBarExtra = false
  private let cli: Task<StimCLI, Never>

  init() {
    BrandAssets.registerFonts()
    CoreSimulator.developerDir = CoreSimulator.selectedDeveloperDir()
    let override = UserDefaults.standard.string(forKey: AppPreferences.Key.stimExecutable)
    let cli = Task.detached {
      StimCLI(environment: await LoginShell.environment() ?? ProcessInfo.processInfo.environment, override: override)
    }
    self.cli = cli
    let store = StatusStore(cli: cli)
    _store = StateObject(wrappedValue: store)
    _notifier = StateObject(wrappedValue: Notifier(store: store))
  }

  var body: some Scene {
    WindowGroup("Stim", id: "main") {
      RootView(cli: cli, store: store)
        .frame(minWidth: 1100, minHeight: 720)
        .onAppear { notifier.start() }
    }
    .windowToolbarStyle(.unified(showsTitle: false))
    .handlesExternalEvents(matching: [])

    Settings {
      SettingsView(cli: cli, store: store)
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
