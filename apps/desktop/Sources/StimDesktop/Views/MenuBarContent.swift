import AppKit
import StimKit
import SwiftUI

struct MenuBarContent: View {
  @ObservedObject var store: StatusStore
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    let live = store.payload?.environments.filter(\.live) ?? []
    Text(live.count == 1 ? "1 live workspace" : "\(live.count) live workspaces")
    if !live.isEmpty {
      Divider()
      ForEach(live) { env in
        Button(
          ([env.names.title] + [env.project?.name, env.names.inCheckout].compactMap { $0 }.filter { $0 != env.names.title })
            .joined(separator: " \u{2014} ")) { open(env.path) }
      }
    }
    Divider()
    Button("Open Stim") { open(nil) }
    SettingsLink { Text("Settings\u{2026}") }
    Divider()
    Button("Quit Stim") { NSApp.terminate(nil) }
  }

  private func open(_ path: String?) {
    OpenRequests.shared.workspacePath = path
    if let window = NSApp.windows.first(where: { $0.identifier?.rawValue.hasPrefix("main") == true }) {
      window.makeKeyAndOrderFront(nil)
    } else {
      openWindow(id: "main")
    }
    NSApp.activate(ignoringOtherApps: true)
  }
}
