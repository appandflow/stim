import StimKit
import SwiftUI

/// What Desktop's stim-server is doing: starting, degraded, running (and whether Desktop started it) or failed.
struct ServerStatusRows: View {
  @ObservedObject var server: ServerController
  let stimHome: String

  @ViewBuilder var body: some View {
    switch server.state {
    case .off:
      EmptyView()
    case .starting, .notReady(.pending, _):
      HStack(spacing: Space.md) {
        ProgressView().controlSize(.small)
        Text("Starting").foregroundStyle(Palette.secondary)
      }
    case .notReady(.degraded(let reason), _):
      Text("Degraded: \(abbreviatingHome(reason)). It retries every 30 seconds.")
        .foregroundStyle(Palette.warning).textSelection(.enabled)
    case .running(let health, let owned):
      Text("stim-server \(health.version) on port \(String(server.port))\(owned ? "" : ", started outside Stim Desktop")")
        .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
      if StimHome.isDefault(stimHome), !health.servesDefaultHome() {
        Text(
          "This server keeps its state in \(abbreviatingHome(health.stimHome)), not ~/.stim.\(FeatureFlags.isEnabled(.phoneApp) ? " Phones paired now stop working when Stim Desktop serves ~/.stim again." : "")"
        )
        .foregroundStyle(Palette.warning)
        .textSelection(.enabled)
      }
    case .failed(let message):
      HStack {
        Text(abbreviatingHome(message)).foregroundStyle(Palette.error).textSelection(.enabled)
        Spacer()
        Button("Try Again", action: server.retry).buttonStyle(.stim())
      }
    }
  }
}
