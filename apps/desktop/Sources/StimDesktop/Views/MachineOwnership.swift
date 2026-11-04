import StimKit
import SwiftUI

struct PlacedWorkSection: View {
  var machine: String
  var work: [PlacedWork]

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      SectionLabel(title: "Your work on \(machine)")
      Card {
        VStack(spacing: 0) {
          if work.isEmpty {
            ListRow { Text(verbatim: "Nothing of yours runs on \(machine) now").foregroundStyle(Palette.tertiary) }
          }
          ForEach(work) { item in
            if item.id != work.first?.id { Divider() }
            ListRow {
              Image(systemName: item.kind.isHostedDevice ? "iphone" : "hammer").foregroundStyle(Palette.secondary)
                .frame(width: 18).accessibilityHidden(true)
              VStack(alignment: .leading, spacing: Space.xxs) {
                Text(verbatim: item.title).font(.stim(.body, weight: .semibold)).lineLimit(1).truncationMode(.middle)
                Text(verbatim: item.place(now: Date())).font(.stim(.caption)).foregroundStyle(Palette.secondary)
                  .lineLimit(1)
              }
              .frame(maxWidth: .infinity, alignment: .leading)
            }
          }
        }
      }
    }
  }
}

struct HostingSection: View {
  var sessions: [HostedSession]
  var stopping: Set<String>
  var stop: (HostedSession) -> Void

  var body: some View {
    if !sessions.isEmpty {
      VStack(alignment: .leading, spacing: Space.md) {
        SectionLabel(title: "Hosting for other machines")
        Card {
          VStack(spacing: 0) {
            ForEach(sessions) { session in
              if session.id != sessions.first?.id { Divider() }
              ListRow {
                HostedSessionRow(session: session, stopping: stopping.contains(session.id)) { stop(session) }
              }
            }
          }
        }
      }
    }
  }
}
