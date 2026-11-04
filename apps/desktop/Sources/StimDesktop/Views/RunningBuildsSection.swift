import StimKit
import StimStores
import SwiftUI

/// The builds running now, on this Mac and on the paired machines whose servers report them, above the history.
/// It appears only once a machine is paired, as nothing else in Builds says where a build runs.
struct RunningBuildsSection: View {
  @ObservedObject var store: StatusStore
  var open: (WorkspaceKey) -> Void
  @ObservedObject private var pairedSessions = PairedServerSessions.shared
  @AppStorage(AppPreferences.Key.machineScope) private var machineScope = MachineScope.all

  var body: some View {
    let machines = store.pairedMachines(pairedSessions.entries)
    let running = RunningBuild.list(local: store.payload?.environments ?? [], machines: machines, scope: machineScope)
    if !machines.isEmpty {
      VStack(alignment: .leading, spacing: Space.lg) {
        HStack(spacing: Space.lg) {
          Text("Running now").font(.stim(.headline))
          Spacer(minLength: 0)
          if machines.contains(where: \.isAvailable) { MachineScopeControl(scope: $machineScope) }
        }
        Card {
          if running.isEmpty {
            InlineEmpty("No builds are running.")
              .font(.stim(.callout))
              .padding(.horizontal, Space.xl).padding(.vertical, Space.lg)
              .frame(maxWidth: .infinity, alignment: .leading)
          } else {
            VStack(spacing: 0) {
              ForEach(Array(running.enumerated()), id: \.element.id) { index, item in
                if index > 0 { Rectangle().fill(Palette.border).frame(height: 1) }
                RunningBuildRow(item: item, machines: machines) { open(item.workspace) }
              }
            }
          }
        }
        if machineScope == .all { UnavailableMachinesNote(machines: machines) }
      }
    }
  }
}

private struct RunningBuildRow: View {
  var item: RunningBuild
  var machines: [PairedMachine]
  var open: () -> Void

  var body: some View {
    Button(action: open) {
      VStack(alignment: .leading, spacing: Space.md) {
        HStack(spacing: Space.md) {
          Text(verbatim: item.title).textStyle(.callout, weight: .semibold).lineLimit(1).truncationMode(.middle)
          if let machine {
            MachineBadge(name: machine.name, access: machine.accessTitle, canControl: machine.canControl)
          } else {
            Pill(size: .small) { Text("This Mac") }
          }
          Spacer(minLength: 0)
        }
        BuildProgressBar(build: item.build)
        FlowLayout(spacing: Space.sm, lineSpacing: Space.sm) {
          ForEach(item.build.phaseSteps, id: \.phase) { step in
            Pill(tone: step.state == .current ? .brand : .neutral, size: .small, outlined: step.state == .upcoming) {
              if step.state == .done { Image(systemName: "checkmark").iconFont(IconSize.micro, weight: .bold) }
              Text(verbatim: step.title)
            }
            .accessibilityLabel(Text(verbatim: "\(step.title), \(label(step.state))"))
          }
        }
      }
      .padding(.horizontal, Space.xl)
      .padding(.vertical, Space.lg)
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .hoverHighlight(radius: 0)
    .help("Open \(item.title)")
  }

  private var machine: PairedMachine? {
    guard case .paired(let id) = item.workspace.owner else { return nil }
    return machines.first { $0.id == id }
  }

  private func label(_ state: BuildPhaseStep.State) -> String {
    switch state {
    case .done: "done"
    case .current: "running"
    case .upcoming: "not started"
    }
  }
}
