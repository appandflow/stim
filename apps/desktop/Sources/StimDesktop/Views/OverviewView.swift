import StimKit
import StimStores
import SwiftUI

struct OverviewView: View {
  @ObservedObject var store: StatusStore
  var metrics: MetricsStore
  @Binding var selection: SidebarItem?
  var openLogs: (String) -> Void
  var openDevice: (String, String) -> Void
  var openIdleProject: (Project) -> Void
  @State private var showsAllActive = false
  @State private var showsAllIdle = false
  @State private var showsAllArchived = false
  @State private var contentWidth: CGFloat = 1000

  private static let projectCardMinimum: CGFloat = 220

  private var projectColumns: Int {
    max(1, Int((contentWidth + Space.lg) / (Self.projectCardMinimum + Space.lg)))
  }

  var body: some View {
    if store.payload == nil {
      if let error = store.error {
        EmptyState(title: "Cannot Read stim status", message: error, showsHero: true)
      } else {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    } else {
      content
    }
  }

  private var projects: [ProjectSummary] { store.projectList }

  private var running: [WallCard] {
    WallCard.cards(environments: (store.payload?.environments ?? []).filter(\.isActive))
  }

  @ViewBuilder private var content: some View {
    let running = running
    let idle = Overview.idleProjects(
      summaries: projects, environments: store.payload?.environments ?? [], project: store.project(ofPath:))
    let archived = ArchivedWorkspace.newestFirst(store.payload?.archived ?? [])
    if running.isEmpty && idle.isEmpty && archived.isEmpty {
      EmptyState(
        title: "Nothing Here Yet",
        message: "Projects appear here when an agent warms a worktree or runs stim ios or stim android.",
        showsHero: true, showsPrompts: true)
    } else {
      ScrollView {
        VStack(alignment: .leading, spacing: Space.xxl) {
          runningSection(running)
          if !idle.isEmpty { idleSection(idle) }
          if !archived.isEmpty { archivedSection(archived) }
        }
        .padding(.horizontal, PageInset.horizontal).padding(.vertical, Space.xxxl)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self, of: { max(0, $0.size.width - PageInset.horizontal * 2) }) { contentWidth = $0 }
      }
    }
  }

  private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      SectionLabel(title: title)
      content()
    }
  }

  private func runningSection(_ cards: [WallCard]) -> some View {
    let columns = WallCard.columns(forWidth: contentWidth)
    let shown = showsAllActive ? cards : Array(cards.prefix(columns))
    return section("Active") {
      if cards.isEmpty {
        Card {
          InlineEmpty("Active projects will appear here when an agent or you start one, for example with `stim start`.")
            .font(.stim(.callout))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Space.xl)
            .padding(.vertical, Space.lg)
        }
      } else {
        WorkspaceCardGrid(
          cards: shown, store: store, metrics: metrics,
          open: { selection = .environment($0.id) }, openDevice: openDevice, openLogs: openLogs)
        if cards.count > columns {
          Button(showsAllActive ? "Show less" : "Show more (\(cards.count - shown.count))") {
            withAnimation(.easeInOut(duration: 0.15)) { showsAllActive.toggle() }
          }
          .buttonStyle(.hoverRow(outset: Space.xs))
          .foregroundStyle(Palette.primary)
        }
      }
    }
  }

  private func idleSection(_ items: [IdleProject]) -> some View {
    let (shown, hidden) = Overview.visibleIdle(items, expanded: showsAllIdle, limit: projectColumns)
    return section("Idle projects") {
      LazyVGrid(
        columns: [GridItem(.adaptive(minimum: Self.projectCardMinimum, maximum: 320), spacing: Space.lg, alignment: .top)],
        alignment: .leading, spacing: Space.lg
      ) {
        ForEach(shown) { idleCard($0) }
      }
      .finiteAccessibilityFrame()
      if items.count > projectColumns {
        Button(showsAllIdle ? "Show less" : "Show more (\(hidden))") {
          withAnimation(.easeInOut(duration: 0.15)) { showsAllIdle.toggle() }
        }
        .buttonStyle(.hoverRow(outset: Space.xs))
        .foregroundStyle(Palette.primary)
      }
    }
  }

  private func idleCard(_ item: IdleProject) -> some View {
    let metadata =
      [countLabel(item.workspaces, "worktree"), item.lastActivity.map { Format.age(Date().timeIntervalSince($0)) }]
      .compactMap { $0 }.joined(separator: " \u{00B7} ")
    let pullRequest = item.pullRequest.map { "PR #\(String($0.number)) \u{00B7} \($0.state)" }
    let failedBuild = item.failedBuild.map { "\($0.platform == "ios" ? "iOS" : "Android") build failed" }
    let errors = item.errors > 0 ? countLabel(item.errors, "error") : nil
    return Button {
      openIdleProject(item.project)
    } label: {
      Card {
        VStack(alignment: .leading, spacing: Space.xs) {
          Text(store.title(of: item.project)).font(.stim(.callout, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1)
          HStack(spacing: Space.sm) {
            Text(metadata).foregroundStyle(Palette.tertiary)
            if let pullRequest {
              Text(pullRequest).foregroundStyle(Color(item.pullRequest?.state == "draft" ? Tone.neutral : Tone.brand))
            }
            if let failedBuild {
              Text(failedBuild).foregroundStyle(Palette.error)
            }
            if let errors {
              Text(errors).foregroundStyle(Palette.error)
            }
          }
          .font(.stim(.caption)).lineLimit(1)
          .help([metadata, pullRequest, failedBuild, errors].compactMap { $0 }.joined(separator: " \u{00B7} "))
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
      }
    }
    .buttonStyle(CardPressStyle())
    .hoverHighlight(radius: Radius.card)
    .accessibilityHint("Open project")
  }

  private func archivedSection(_ items: [ArchivedWorkspace]) -> some View {
    let shown = showsAllArchived ? items : Array(items.prefix(projectColumns))
    return section("Recently archived") {
      LazyVGrid(
        columns: [GridItem(.adaptive(minimum: Self.projectCardMinimum, maximum: 320), spacing: Space.lg, alignment: .top)],
        alignment: .leading, spacing: Space.lg
      ) {
        ForEach(shown) { archive in
          Button {
            selection = .archived(archive.id)
          } label: {
            Card {
              VStack(alignment: .leading, spacing: Space.xs) {
                Text(archive.title).font(.stim(.callout, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1)
                Text(archive.removedLabel(now: Date()).replacingOccurrences(of: "Removed ", with: ""))
                  .font(.stim(.caption)).foregroundStyle(Palette.tertiary).lineLimit(1)
              }
              .padding(.horizontal, Space.lg)
              .padding(.vertical, Space.md)
              .frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(Rectangle())
            }
          }
          .buttonStyle(CardPressStyle())
          .hoverHighlight(radius: Radius.card)
          .help("Open the archive of \(archive.title)")
        }
      }
      .finiteAccessibilityFrame()
      if items.count > projectColumns {
        Button(showsAllArchived ? "Show less" : "Show more (\(items.count - shown.count))") {
          withAnimation(.easeInOut(duration: 0.15)) { showsAllArchived.toggle() }
        }
        .buttonStyle(.hoverRow(outset: Space.xs))
        .foregroundStyle(Palette.primary)
      }
    }
  }
}
