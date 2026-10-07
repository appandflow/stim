import StimKit
import SwiftUI

struct SidebarWorktreeRow: View {
  var page: WorktreePage
  var subtitle: String?
  var showsGit: Bool
  var selection: SidebarItem?
  var openLogs: (String) -> Void
  var archives: [ArchivedWorkspace] = []
  #if DEBUG
    @Environment(\.fixtureDate) private var fixtureDate
  #else
    private var fixtureDate: Date? { nil }
  #endif

  var body: some View {
    let showLogs = { (app: Workspace) in openLogs(app.path) }
    if archives.isEmpty {
      WorktreeActions(page: page, openLogs: showLogs) { menu in
        row
          .tutorialAnchor(.sidebarRow, workspace: page.apps.first(where: { $0.tutorial != nil })?.path ?? page.id)
          .sidebarTag(.environment(page.id), selection: selection)
          .contextMenu { menu }
      }
    } else {
      row
    }
  }

  private func summary(now: Date) -> WorktreeRowSummary {
    var summary = page.rowSummary(now: now, subtitle: subtitle, showsGit: showsGit)
    if !archives.isEmpty {
      summary.status.text = "Removed"
      summary.status.label = "Removed"
      summary.status.tone = .tertiary
      summary.agents = []
      summary.git = nil
      summary.problems = []
      summary.subtitle = "\(archives[0].removedLabel(now: now)), \(Format.fileSize(archives.reduce(0) { $0 + $1.bytes.total }))"
      for index in summary.apps.indices {
        summary.apps[index].label = (WorktreePage.project(page.apps[index]) as NSString).lastPathComponent
        summary.apps[index].status = summary.status
      }
    }
    return summary
  }

  private var row: some View {
    TimelineView(.everyMinute) { tick in
      let now = fixtureDate ?? tick.date
      let summary = summary(now: now)
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
          if archives.isEmpty, let session = summary.agents.first {
            SessionLine(session: session, others: summary.agents.count - 1)
          }
          AppBadges(apps: summary.apps)
          if let archive = archives.first {
            let adapted = ArchivedPage(archive: archive, now: now)
            RowDetailLine(
              context: Text(
                "\(archive.removedLabel(now: now)) \u{00B7} \(Format.fileSize(archives.reduce(0) { $0 + $1.bytes.total }))"
              )
              .foregroundStyle(Palette.tertiary), git: nil)
            ArchiveRowFacts(page: adapted, showsGit: showsGit)
          } else {
            RowDetailLine(context: context(summary), git: summary.git)
            ForEach(page.apps.flatMap(\.orderedDevices).filter { $0.placement != nil }) {
              device in
              DevicePlacementView(device: device)
            }
          }
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(summary.label)
      .accessibilityActions {
        if archives.isEmpty, let app = page.apps.first(where: { ($0.logs?.errorsSinceMarker ?? 0) > 0 }) {
          Button("Show errors") { openLogs(app.path) }
        }
      }
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
