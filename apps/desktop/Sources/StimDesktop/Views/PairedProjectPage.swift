import StimKit
import StimStores
import SwiftUI

struct PairedProjectPage: View {
  @ObservedObject var store: StatusStore
  var metrics: MetricsStore
  var machine: PairedMachine?
  var project: Project
  @Binding var selection: SidebarItem?
  var openLogs: (String) -> Void
  var openDevice: (WorkspaceKey, String) -> Void

  var body: some View {
    if let machine {
      if !machine.isAvailable {
        EmptyState(
          title: "Waiting for \(machine.name)", message: "Stim Desktop shows this project once the machine reports it.")
      } else if !machine.workspaces.contains(where: { ($0.project ?? Project(fallbackFor: $0.path)) == project }) {
        EmptyState(title: "Project Gone", message: "\(machine.name) no longer reports this project.")
      } else {
        let cards = WallCard.cards(machine: machine, project: project)
        ScrollView {
          LazyVStack(alignment: .leading, spacing: Space.xl) {
            HStack(spacing: Space.lg) {
              Text(verbatim: project.name).font(.stim(.title))
              Text(verbatim: machine.name).font(.stim(.callout)).foregroundStyle(Palette.secondary)
            }
            WorkspaceCardGrid(
              cards: cards, store: store, metrics: metrics,
              open: { selection = $0.pairedDestination }, openDevice: openDevice, openLogs: openLogs)
          }
          .finiteAccessibilityFrame()
          .padding(.horizontal, PageInset.horizontal).padding(.vertical, Space.xxxl)
        }
      }
    } else {
      EmptyState(title: "Machine Not Paired", message: "Stim Desktop no longer has a pairing with this machine.")
    }
  }
}
