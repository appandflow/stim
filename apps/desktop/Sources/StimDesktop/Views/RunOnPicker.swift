import StimKit
import StimStores
import SwiftUI

private struct RunMachinesKey: EnvironmentKey {
  static let defaultValue: BuildMachinesModel? = nil
}

extension EnvironmentValues {
  var runMachines: BuildMachinesModel? {
    get { self[RunMachinesKey.self] }
    set { self[RunMachinesKey.self] = newValue }
  }
}

struct RunOnPicker: View {
  var workspace: String
  var platform: String
  var fixedMachine: String?
  var localDeviceBooted: Bool
  @Environment(\.runMachines) private var machines
  @AppStorage private var saved: String

  init(workspace: String, platform: String, fixedMachine: String? = nil, localDeviceBooted: Bool = false) {
    self.workspace = workspace
    self.platform = platform
    self.fixedMachine = fixedMachine
    self.localDeviceBooted = localDeviceBooted
    _saved = AppStorage(wrappedValue: "", AppPreferences.Key.runDestination(workspace: workspace, platform: platform))
  }

  var body: some View {
    if ["ios", "android"].contains(platform) {
      let approved = machines?.approvedHostingMachines(in: workspace)
      let destination =
        fixedMachine.map { RunDestination.machine($0) }
        ?? RunDestination(saved: saved, approvedMachines: approved)
      Menu {
        if let fixedMachine {
          Text("Runs on \(machineName(fixedMachine)); run stim stop first to change machines.")
        } else {
          Picker("Run on", selection: Binding(get: { destination.saved }, set: { saved = $0 })) {
            Text("This Mac").tag("")
            Text("Auto").tag("auto")
            ForEach(approved ?? (saved.isEmpty || saved == "auto" ? [] : [saved]), id: \.self) { machine in
              Text(machineName(machine)).tag(machine)
                .disabled(localDeviceBooted)
                .help(localDeviceBooted ? "Run stim stop first to change machines." : "")
            }
          }
          .onAppear { refreshMachines() }
        }
      } label: {
        Text("Run on: \(destination.title)")
      }
      .menuStyle(.borderlessButton)
      .font(.stim(.footnote))
      .foregroundStyle(Palette.secondary)
      .fixedSize()
      .disabled(fixedMachine != nil)
      .help(
        fixedMachine != nil
          ? "Run stim stop first to change machines."
          : "This Mac uses the project's default (no --remote); ios.remote or android.remote still applies. Auto uses this Mac while it has room, otherwise an approved hosting Mac."
      )
      .onAppear { refreshMachines() }
      .simultaneousGesture(TapGesture().onEnded { refreshMachines() })
    }
  }
  private func refreshMachines() {
    guard fixedMachine == nil, let machines else { return }
    Task { await machines.refreshHostingMachines(checkout: workspace) }
  }
}

struct DeviceRunButton: View {
  var device: DeviceRef
  var workspace: String
  var title: String
  var native: Bool
  var disabled: Bool
  var present: Bool
  @Environment(\.runMachines) private var machines
  @EnvironmentObject private var actions: ActionCenter
  @AppStorage private var saved: String

  init(device: DeviceRef, workspace: String, title: String, native: Bool = false, disabled: Bool = false, present: Bool = false) {
    self.device = device
    self.workspace = workspace
    self.title = title
    self.native = native
    self.disabled = disabled
    self.present = present
    _saved = AppStorage(wrappedValue: "", AppPreferences.Key.runDestination(workspace: workspace, platform: device.platform))
  }

  private var isDisabled: Bool { disabled || actions.active(for: workspace) != nil }

  var body: some View {
    let destination = RunDestination(saved: saved, approvedMachines: machines?.approvedHostingMachines(in: workspace))
    if let command = runCommand(for: device, cwd: workspace, destination: destination) {
      RunOnPicker(
        workspace: workspace, platform: device.platform, fixedMachine: device.hostedMachine,
        localDeviceBooted: device.isBootedLocalOwnedDevice)
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
      let destination = AppPreferences.runDestination(
        workspace: workspace, platform: device.platform, approvedMachines: machines?.approvedHostingMachines(in: workspace))
      guard let command = runCommand(for: device, cwd: workspace, destination: destination) else { return }
      actions.run(
        native ? "Run on \(platformName(device.platform))" : device.platform == "web" ? "Open web" : "Run \(device.slot)",
        steps: [command], present: present)
    }
    if native { button.nativeControlStyle(.primary) } else { button.buttonStyle(.stim()) }
  }
}

struct DevicePlacementLabel: View {
  var device: DeviceRef

  var body: some View {
    VStack(alignment: .leading, spacing: Space.xxs) {
      if let machine = device.hostedMachine {
        Label("on \(machineName(machine))", systemImage: "desktopcomputer")
      }
      if let reason = device.placementReason { Text(reason).lineLimit(1).help(reason) }
    }
    .font(.stim(.caption))
    .foregroundStyle(Palette.tertiary)
  }
}
