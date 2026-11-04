import StimKit
import StimStores
import SwiftUI

extension StatusStore {
  /// The paired machines in `entries` with what their servers report now.
  func pairedMachines(_ entries: [PairedServers.Entry]) -> [PairedMachine] {
    PairedMachine.list(entries: entries) { id in paired[id].map { (payload: $0.payload, delivering: $0.delivering) } }
  }
}

/// Switches Active Workspaces, the Overview and Builds between this Mac and every machine.
struct MachineScopeControl: View {
  @Binding var scope: MachineScope

  var body: some View {
    Picker("Machines", selection: $scope) {
      ForEach(MachineScope.allCases, id: \.self) { Text($0.title).tag($0) }
    }
    .pickerStyle(.segmented)
    .labelsHidden()
    .fixedSize()
    .help("List workspaces of this Mac only, or of every paired machine too")
  }
}

/// The paired machine a card or row belongs to, and what this Mac may do there.
struct MachineBadge: View {
  var name: String
  var access: String
  var canControl: Bool

  init(machine: WallCard.Machine) {
    self.init(name: machine.name, access: machine.accessTitle, canControl: machine.canControl)
  }

  init(name: String, access: String, canControl: Bool) {
    self.name = name
    self.access = access
    self.canControl = canControl
  }

  var body: some View {
    HStack(spacing: Space.sm) {
      Image(systemName: "link").iconFont(IconSize.small).foregroundStyle(Palette.secondary).accessibilityHidden(true)
      Text(verbatim: name).font(.stim(.caption, weight: .semibold)).foregroundStyle(Palette.secondary).lineLimit(1)
        .truncationMode(.middle)
      Pill(tone: canControl ? .brand : .neutral, size: .small) { Text(access) }
    }
    .fixedSize(horizontal: false, vertical: true)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text(verbatim: "\(name), \(access)"))
    .help(Text(verbatim: "\(name) is a paired machine. This Mac has \(access.lowercased()) access."))
  }
}

/// The paired machines that cannot report now, so the lists above leave their workspaces out.
struct UnavailableMachinesNote: View {
  var machines: [PairedMachine]

  var body: some View {
    let down = machines.filter { !$0.isAvailable }
    if !down.isEmpty {
      Label {
        Text(
          verbatim: down.count == 1
            ? "\(down[0].name) is unavailable, so its workspaces are not listed."
            : "\(down.map(\.name).formatted()) are unavailable, so their workspaces are not listed.")
      } icon: {
        Image(systemName: "wifi.slash")
      }
      .font(.stim(.caption))
      .foregroundStyle(Palette.tertiary)
    }
  }
}
