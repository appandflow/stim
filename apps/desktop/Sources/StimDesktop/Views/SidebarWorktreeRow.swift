import StimKit
import SwiftUI

struct SidebarWorktreeRow: View {
  var page: WorktreePage
  var subtitle: String?
  var showsGit: Bool
  var selection: SidebarItem?
  var openLogs: (String) -> Void

  var body: some View {
    let showLogs = { (app: Workspace) in openLogs(app.path) }
    WorktreeActions(page: page, openLogs: showLogs) { menu in
      TimelineView(.everyMinute) { _ in
        let summary = page.rowSummary(now: Date(), subtitle: subtitle, showsGit: showsGit)
        HStack(alignment: .top, spacing: Space.md) {
          StatusDot(color: Color(summary.status.tone), filled: summary.active)
            .padding(.top, Space.sm - 1)
          VStack(alignment: .leading, spacing: Space.xs) {
            HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
              Text(summary.title).foregroundStyle(summary.active ? Palette.text : Palette.secondary)
                .lineLimit(1).truncationMode(.middle).layoutPriority(1)
              Spacer(minLength: 0)
              Text(summary.status.text).font(.stim(.caption, weight: .medium)).foregroundStyle(Color(summary.status.tone))
                .lineLimit(1).fixedSize()
            }
            if let session = summary.agents.first {
              SessionLine(session: session, others: summary.agents.count - 1)
            }
            AppBadges(apps: summary.apps)
            RowDetailLine(context: context(summary), git: summary.git)
          }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(summary.label)
        .accessibilityActions {
          if let app = page.apps.first(where: { ($0.logs?.errorsSinceMarker ?? 0) > 0 }) {
            Button("Show errors") { openLogs(app.path) }
          }
        }
      }
      .sidebarTag(.environment(page.id), selection: selection)
      .contextMenu { menu }
    }
  }

  private func context(_ summary: WorktreeRowSummary) -> Text? {
    var parts: [Text] = []
    if let drivers = summary.drivers {
      parts.append(Text("\(Image(systemName: "cursorarrow.rays")) \(drivers)").foregroundStyle(Palette.primary))
    }
    if summary.remote > 0 {
      let text = summary.remote == 1 ? "EAS session" : "\(summary.remote) EAS sessions"
      parts.append(Text(text).foregroundStyle(Palette.info))
    }
    if let subtitle = summary.subtitle { parts.append(Text(subtitle).foregroundStyle(Palette.tertiary)) }
    return RowDetailLine.joined(parts)
  }
}

private struct AppBadges: View {
  var apps: [WorktreeRowSummary.App]

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: Space.md) { badges }.fixedSize()
      VStack(alignment: .leading, spacing: Space.xs) { badges }
    }
    .font(.stim(.caption))
  }

  private var badges: some View {
    ForEach(apps.indices, id: \.self) { index in
      let app = apps[index]
      HStack(spacing: Space.xs) {
        StatusDot(color: Color(app.status.tone), filled: app.active)
        Text(app.label).foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.tail)
      }
    }
  }
}
