import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
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
  }

  var body: some Scene {
    WindowGroup("Stim") {
      RootView()
        .frame(minWidth: 1100, minHeight: 720)
    }
    .windowToolbarStyle(.unified(showsTitle: false))
  }
}
