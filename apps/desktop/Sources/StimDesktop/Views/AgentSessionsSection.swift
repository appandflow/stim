import AppKit
import StimKit
import SwiftUI

/// The coding-agent sessions working in a workspace, then, muted, those that ended there. A session with a desktop app
/// link opens there on click.
struct AgentSessionsSection: View {
  var agents: [AgentSession]

  var body: some View {
    TimelineView(.periodic(from: .now, by: 30)) { context in
      VStack(alignment: .leading, spacing: Space.md) {
        SectionLabel(title: "Agents")
        ForEach(agents) { agent in
          if let url = agent.openURL {
            Button {
              NSWorkspace.shared.open(url)
            } label: {
              HStack(spacing: Space.sm) {
                Text(agent.label(now: context.date)).lineLimit(1).truncationMode(.middle)
                Image(systemName: "arrow.up.forward.app")
              }
              .foregroundStyle(agent.ended ? Palette.secondary : Palette.accent)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(agent.openHelp)
          } else {
            Text(agent.label(now: context.date)).lineLimit(1).truncationMode(.middle)
              .foregroundStyle(agent.ended ? Palette.tertiary : Palette.secondary)
          }
        }
      }
    }
  }
}
