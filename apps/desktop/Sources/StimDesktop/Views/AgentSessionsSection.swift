import AppKit
import StimKit
import SwiftUI

/// The coding-agent sessions associated with a workspace, the one that first worked there on top. A session with a
/// desktop app link opens there on click.
struct AgentSessionsSection: View {
  var agents: [AgentSession]

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      SectionLabel(title: "Agents")
      ForEach(agents) { agent in
        if let url = agent.openURL {
          Button {
            NSWorkspace.shared.open(url)
          } label: {
            HStack(spacing: Space.sm) {
              Text(agent.label).lineLimit(1).truncationMode(.middle)
              Image(systemName: "arrow.up.forward.app")
            }
            .foregroundStyle(Palette.accent)
          }
          .buttonStyle(.hoverRow(outset: Space.xs))
          .help(agent.openHelp)
        } else {
          Text(agent.label).lineLimit(1).truncationMode(.middle)
            .foregroundStyle(Palette.secondary)
        }
      }
    }
  }
}
