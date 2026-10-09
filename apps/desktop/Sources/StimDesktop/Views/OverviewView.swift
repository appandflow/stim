import StimKit
import StimStores
import SwiftUI

struct OverviewView: View {
  @ObservedObject var store: StatusStore
  var metrics: MetricsStore
  var machines: BuildMachinesModel
  var sidebarTopic: TipTopic?
  @Binding var selection: SidebarItem?
  var openLogs: (String) -> Void
  var openDevice: (String, String) -> Void
  var openIdleProject: (Project) -> Void
  @State private var showsAllIdle = false
  @State private var capabilities: [String: ProjectCapabilities] = [:]
  @State private var capabilitiesLoaded = false
  @State private var dismissedTips = TryThisStore(defaults: .standard).dismissed
  @State private var tipState = TryThisStore(defaults: .standard).state

  private static let cardWidth: CGFloat = 340

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
    let archived = Overview.recentlyArchived(store.payload?.archived ?? [])
    let tip = tip
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
          if let tip { tipSection(tip) }
        }
        .padding(Space.xxxl)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .task(id: projects.map(\.project.root)) {
        let roots = projects.map(\.project.root)
        capabilities = await Task.detached {
          Dictionary(uniqueKeysWithValues: roots.map { ($0, ProjectCapabilities.detect(root: $0)) })
        }.value
        capabilitiesLoaded = true
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
    section("Active") {
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
          cards: cards, store: store, metrics: metrics,
          open: { selection = .environment($0.id) }, openDevice: openDevice, openLogs: openLogs)
      }
    }
  }

  private func idleSection(_ items: [IdleProject]) -> some View {
    let (shown, hidden) = Overview.visibleIdle(items, expanded: showsAllIdle)
    return section("Idle projects") {
      LazyVGrid(
        columns: [GridItem(.adaptive(minimum: 220, maximum: 320), spacing: Space.lg, alignment: .top)],
        alignment: .leading, spacing: Space.lg
      ) {
        ForEach(shown) { idleCard($0) }
      }
      .finiteAccessibilityFrame()
      if items.count > Overview.idleShown {
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
    section("Recently archived") {
      FlowLayout(spacing: Space.md, lineSpacing: Space.md) {
        ForEach(items) { archive in
          Button {
            selection = .archived(archive.id)
          } label: {
            Pill {
              Text(archive.title)
              Text(archive.removedLabel(now: Date()).replacingOccurrences(of: "Removed ", with: ""))
                .foregroundStyle(Palette.tertiary)
            }
          }
          .buttonStyle(.hoverRow())
          .help("Open the archive of \(archive.title)")
        }
      }
    }
  }

  private var tipInputs: TryThisInputs {
    var inputs = TryThisInputs()
    inputs.remoteMachines =
      machines.settings.error == nil
      ? machines.settings.payload.map { $0.entry("remote.machines")?.value.strings ?? [] } : nil
    inputs.hasEASProject = capabilities.values.contains { $0.eas }
    inputs.hasMacosTarget = capabilities.values.contains { $0.macos }
    inputs.workspaces = store.payload?.environments ?? []
    return inputs
  }

  private var tip: TryThisTip? {
    guard capabilitiesLoaded, machines.settings.payload != nil || machines.settings.error != nil else { return nil }
    return TryThis.select(
      inputs: tipInputs, dismissed: dismissedTips, sidebarTopic: sidebarTopic, state: tipState, now: Date(),
      calendar: .current)
  }

  private func showNextTip(after tip: TryThisTip) {
    guard
      let next = TryThis.next(
        after: tip, inputs: tipInputs, dismissed: dismissedTips, sidebarTopic: sidebarTopic)
    else { return }
    recordTip(next)
  }

  private func recordTip(_ tip: TryThisTip) {
    var state = tipState
    let now = Date()
    let today = Tips.day(now, calendar: .current)
    guard state.current?.tip != tip || state.current?.day != today else { return }
    TryThis.record(tip, state: &state, now: now, calendar: .current)
    tipState = state
    TryThisStore(defaults: .standard).state = state
  }

  private func tipSection(_ tip: TryThisTip) -> some View {
    section("Try this") {
      let prompt = TryThisPrompts.byTip[tip.rawValue] ?? ""
      let hasNext = TryThis.next(after: tip, inputs: tipInputs, dismissed: dismissedTips, sidebarTopic: sidebarTopic) != nil
      Card {
        VStack(alignment: .leading, spacing: Space.md) {
          HStack(alignment: .top) {
            Image(systemName: "lightbulb").foregroundStyle(Palette.accent)
            Text(tip.title).font(.stim(.headline)).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            IconButton(systemImage: "xmark", help: "Dismiss this tip", circular: true) {
              TryThisStore(defaults: .standard).dismiss(tip)
              dismissedTips.insert(tip)
            }
          }
          Text(tip.detail).font(.stim(.callout)).foregroundStyle(Palette.secondary)
            .fixedSize(horizontal: false, vertical: true)
          Text(prompt)
            .font(.stim(.caption, mono: true))
            .foregroundStyle(Palette.secondary)
            .lineLimit(6)
            .padding(Space.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.raised, in: RoundedRectangle(cornerRadius: Radius.chip))
          HStack {
            if hasNext { Button("Next Tip") { showNextTip(after: tip) }.buttonStyle(.stim(.plain, .small)) }
            Spacer(minLength: 0)
            CopyButton(prompt, title: "Copy Prompt", accessibilityLabel: "Copy prompt: \(tip.title)")
          }
        }
        .padding(Space.xl)
      }
      .frame(maxWidth: Self.cardWidth * 2, alignment: .leading)
      .onChange(of: tip, initial: true) { _, tip in recordTip(tip) }
    }
  }
}
