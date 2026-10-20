import StimKit
import StimStores
import SwiftUI

/// The "..." menu on a simulator, emulator or macOS app tile: the same Build and Run and Stop for each, and for a
/// macOS app its window and build logs.
struct DeviceTileMenu: View {
  var device: DeviceRef
  var workspace: String
  var building: Bool
  @ObservedObject var choice: MacosWindowChoice
  var openBuildLogs: (() -> Void)?
  @EnvironmentObject private var actions: ActionCenter

  static func applies(to device: DeviceRef) -> Bool {
    if device.isPhysical { return false }
    switch device {
    case .ios, .android, .macos: return true
    case .remote, .web: return false
    }
  }

  var body: some View {
    let busy = actions.active(for: workspace) != nil
    Menu {
      if let run = runCommand(for: device, cwd: workspace) {
        Button("Build and Run", systemImage: "play.fill") {
          actions.run("Run \(device.label)", steps: [run], present: false)
        }
        .disabled(building || busy)
      }
      Button("Stop", systemImage: "stop.fill") {
        actions.run("Stop \(device.label)", steps: [stopCommand(for: device, cwd: workspace)], present: false)
      }
      .disabled(
        !(device.isRunning || device.state == "orphaned" || device.hostedMachine != nil && device.state != "stopped") || busy)
      if case .macos = device {
        if device.hostedMachine == nil {
          Button("Bring to Front", systemImage: "arrow.up.forward.app") { choice.open() }
            .disabled(!choice.canOpen)
        }
        if choice.windows.count > 1 || choice.pinned {
          Divider()
          Toggle("Follow Front Window", isOn: Binding(get: { !choice.pinned }, set: { if $0 { choice.select(nil) } }))
            .disabled(!choice.canSelect)
          ForEach(choice.windows) { window in
            Toggle(
              window.title.isEmpty ? "Untitled Window" : window.title,
              isOn: Binding(get: { choice.pinned && window.id == choice.current }, set: { if $0 { choice.select(window.id) } })
            )
            .disabled(!choice.canSelect)
          }
        }
        if let openBuildLogs {
          Divider()
          Button("Build Logs", systemImage: "doc.text.magnifyingglass", action: openBuildLogs)
        }
      }
    } label: {
      Image(systemName: "ellipsis")
    }
    .menuStyle(.button)
    .menuIndicator(.hidden)
    .buttonStyle(.borderless)
    .fixedSize()
    .help("Device actions")
    .accessibilityLabel("Device actions")
  }
}
