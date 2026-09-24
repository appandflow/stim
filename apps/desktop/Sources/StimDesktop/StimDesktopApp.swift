import AppKit
import SimulatorFrames
import StimKit
import SwiftUI

@MainActor
final class OpenRequests: ObservableObject {
  static let shared = OpenRequests()
  @Published var simulatorUdid: String?
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
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct StimDesktopApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

  init() {
    BrandAssets.registerFonts()
    CoreSimulator.developerDir = CoreSimulator.selectedDeveloperDir()
  }

  var body: some Scene {
    WindowGroup("Stim") {
      RootView()
        .frame(minWidth: 1100, minHeight: 720)
    }
    .windowToolbarStyle(.unified(showsTitle: false))
    .handlesExternalEvents(matching: [])
  }
}
