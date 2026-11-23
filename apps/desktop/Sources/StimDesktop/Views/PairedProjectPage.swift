import StimKit
import StimStores
import SwiftUI

struct PairedProjectPage: View {
  @ObservedObject var store: StatusStore
  var metrics: MetricsStore
  var owner: ServerOwner
  var project: Project
  @Binding var selection: SidebarItem?
  var openLogs: (String) -> Void
  var openDevice: (WorkspaceKey, String) -> Void
  @ObservedObject private var sessions = PairedServerSessions.shared

  var body: some View {
    if let machine = store.pairedMachines(sessions.entries).first(where: { $0.owner == owner }) {
      if !machine.isAvailable {
        EmptyState(
          title: "Waiting for \(machine.name)", message: "Stim Desktop shows this project once the machine reports it.")
      } else if !machine.workspaces.contains(where: { ($0.project ?? Project(fallbackFor: $0.path)) == project }) {
        EmptyState(title: "Project Gone", message: "\(machine.name) no longer reports this project.")
      } else {
        let cards = WallCard.cards(machine: machine, project: project)
        if cards.isEmpty {
          EmptyState(
            title: "No Active Workspaces in \(project.name)",
            message: "The project has workspaces, but none is running or being set up.")
        } else {
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
      }
    } else {
      EmptyState(title: "Machine Not Paired", message: "Stim Desktop no longer has a pairing with this machine.")
    }
  }
}
