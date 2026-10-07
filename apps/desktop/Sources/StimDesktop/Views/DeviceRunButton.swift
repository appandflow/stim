import StimKit
import StimStores
import SwiftUI

struct DeviceRunButton: View {
  var device: DeviceRef
  var workspace: String
  var title: String
  var native: Bool
  var disabled: Bool
  var present: Bool
  @EnvironmentObject private var actions: ActionCenter

  init(device: DeviceRef, workspace: String, title: String, native: Bool = false, disabled: Bool = false, present: Bool = false) {
    self.device = device
    self.workspace = workspace
    self.title = title
    self.native = native
    self.disabled = disabled
    self.present = present
  }

  private var isDisabled: Bool { disabled || actions.active(for: workspace) != nil }

  var body: some View {
    if let command = runCommand(for: device, cwd: workspace) {
      button()
        .fixedSize()
        .disabled(isDisabled)
        .help(
          isDisabled
            ? "Wait for the running action or build in this workspace to finish.\n\(command.displayLine())"
            : command.displayLine())
    }
  }

  @ViewBuilder private func button() -> some View {
    let button = Button(title, systemImage: "play.fill") {
      guard let command = runCommand(for: device, cwd: workspace) else { return }
      actions.run(
        native ? "Run on \(platformName(device.platform))" : device.platform == "web" ? "Open web" : "Run \(device.slot)",
        steps: [command], present: present)
    }
    if native { button.nativeControlStyle(.primary) } else { button.buttonStyle(.stim()) }
  }
}
