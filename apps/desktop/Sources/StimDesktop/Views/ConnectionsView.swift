import StimKit
import StimStores
import SwiftUI

/// Settings > Connections: who uses this machine and what this machine uses, one segment each.
struct ConnectionsView: View {
  @Binding var segment: ConnectionsSegment
  @ObservedObject var store: StatusStore
  var machine: MachineSettingsStore
  var buildMachines: BuildMachinesModel
  @ObservedObject var ledger: BuildLedgerModel
  var workspace: String?
  var actions: ActionCenter

  var body: some View {
    VStack(spacing: 0) {
      Picker("Direction", selection: $segment) {
        Text("Using this machine").tag(ConnectionsSegment.incoming)
        Text("This machine uses").tag(ConnectionsSegment.outgoing)
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .tint(Palette.brand)
      .fixedSize()
      .padding(.top, Space.xl)
      switch segment {
      case .incoming:
        IncomingConnectionsView(server: .shared, store: store, stimHome: store.stimHome, machine: machine)
      case .outgoing:
        BuildMachinesView(model: buildMachines, ledger: ledger, store: store, workspace: workspace, actions: actions)
      }
    }
    .background(Palette.background)
    .onReceive(OpenRequests.shared.$addMachine) { if $0 != nil { segment = .outgoing } }
    .onReceive(OpenRequests.shared.$pairsPhone) { if $0 { segment = .incoming } }
  }
}

enum ConnectionsSegment: String {
  case incoming, outgoing

  init?(legacyTab: String) {
    switch legacyTab {
    case "phones", "web-shares": self = .incoming
    case "build-machines", "paired-machines": self = .outgoing
    default: return nil
    }
  }
}
