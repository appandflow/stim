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
  @State private var pressedCard: SidebarItem?
  @State private var capabilities: [String: ProjectCapabilities] = [:]
  @State private var dismissedTips = TryThisStore(defaults: .standard).dismissed

  private static let cardWidth: CGFloat = 340

  var body: some View {
    if store.payload == nil {
      if let error = store.error {
        EmptyState(title: "Cannot read stim status", message: error, showsHero: true)
      } else {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    } else {
      content
    }
  }

  private var projects: [ProjectSummary] { store.projectList }

  private var running: [(summary: ProjectSummary, worktrees: [WorktreePage])] {
    projects.compactMap { summary in
      let worktrees = WorktreePage.groups(
        environments: store.environments(in: summary.project).filter(\.isActive)
      ).sorted { $0.identity < $1.identity }
      return worktrees.isEmpty ? nil : (summary, worktrees)
    }
  }

  @ViewBuilder private var content: some View {
    let running = running
    let idle = Overview.idleProjects(
      summaries: projects, environments: store.payload?.environments ?? [], project: store.project(ofPath:))
    let archived = Overview.recentlyArchived(store.payload?.archived ?? [])
    let tips = tips
    if running.isEmpty && idle.isEmpty && archived.isEmpty {
      EmptyState(
        title: "Nothing here yet",
        message: "Projects appear here when an agent warms a worktree or runs stim ios or stim android.",
        showsHero: true, showsPrompts: true)
    } else {
      ScrollView {
        VStack(alignment: .leading, spacing: Space.xxl) {
          if !running.isEmpty { runningSection(running) }
          if !idle.isEmpty { idleSection(idle) }
          if !archived.isEmpty { archivedSection(archived) }
          if !tips.isEmpty { tipsSection(tips) }
        }
        .padding(Space.xxxl)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .task(id: projects.map(\.project.root)) {
        let roots = projects.map(\.project.root)
        capabilities = await Task.detached {
          Dictionary(uniqueKeysWithValues: roots.map { ($0, ProjectCapabilities.detect(root: $0)) })
        }.value
      }
    }
  }

  private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      SectionLabel(title: title)
      content()
    }
  }

  private func runningSection(_ items: [(summary: ProjectSummary, worktrees: [WorktreePage])]) -> some View {
    section("Running") {
      LazyVGrid(
        columns: [
          GridItem(.adaptive(minimum: Self.cardWidth, maximum: Self.cardWidth * 1.4), spacing: Space.xl, alignment: .top)
        ],
        alignment: .center, spacing: Space.xl
      ) {
        ForEach(items, id: \.summary.project.id) { item in
          projectCard(item.summary, item.worktrees)
        }
      }
      .frame(maxWidth: Self.cardWidth * 1.4 * CGFloat(min(3, items.count)) + Space.xl * CGFloat(min(3, items.count) - 1))
      .frame(maxWidth: .infinity, alignment: items.count < 3 ? .center : .leading)
    }
  }

  private func projectCard(_ summary: ProjectSummary, _ worktrees: [WorktreePage]) -> some View {
    let itemCount = worktrees.reduce(0) { $0 + max(1, $1.orderedDevices.filter { $0.device.isRunning }.count) }
    let moreCount = itemCount - 1
    return Button {
      pressedCard = nil
      selection = .project(summary.project)
    } label: {
      Card {
        VStack(alignment: .center, spacing: Space.xl) {
          Text(store.title(of: summary.project))
            .font(.stim(.headline))
            .foregroundStyle(Palette.text)
            .lineLimit(2)
          preview(worktrees)
            .allowsHitTesting(false)
          if moreCount > 0 {
            Text("Show more (\(moreCount))")
              .foregroundStyle(Palette.tertiary)
          }
        }
        .padding(Space.xl)
        .frame(maxWidth: .infinity, alignment: .center)
        .multilineTextAlignment(.center)
        .contentShape(Rectangle())
      }
    }
    .buttonStyle(CardPressStyle())
    .hoverHighlight(radius: Radius.card)
    .modifier(CardPressAppearance(pressed: pressedCard == .project(summary.project)))
    .onPreferenceChange(CardPressedKey.self) { pressed in
      if pressed {
        pressedCard = .project(summary.project)
      } else if pressedCard == .project(summary.project) {
        pressedCard = nil
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(store.title(of: summary.project))
    .accessibilityValue(moreCount > 0 ? "Show more (\(moreCount))" : "")
    .accessibilityHint("Open project")
  }

  private func preview(_ worktrees: [WorktreePage]) -> some View {
    let preview = worktrees.flatMap(\.orderedDevices).first { $0.device.isRunning }
    return VStack(alignment: .center, spacing: Space.lg) {
      if let env = preview?.workspace ?? worktrees.first?.apps.first {
        WorkspaceHeader(
          env: env, project: store.project(of: env), usage: metrics.usage[env.path], stacked: true,
          openLogs: { openLogs(env.path) }
        )
        if let preview {
          DeviceTile(
            device: preview.device, screenHeight: 220, workspace: env.path,
            build: env.runningBuild(for: preview.device), maxWidth: 240, pausesWhenOffscreen: true
          )
          .frame(maxWidth: .infinity, alignment: .center)
        }
        if let macos = env.macos {
          Label("\(macos.product) \u{00B7} \(macos.state)", systemImage: "macwindow")
            .font(.stim(.callout))
            .foregroundStyle(Palette.secondary)
        }
      }
    }
  }

  private func idleSection(_ items: [IdleProject]) -> some View {
    section("Idle projects") {
      Card {
        VStack(spacing: 0) {
          ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
            if index > 0 { Rectangle().fill(Palette.border).frame(height: 1) }
            idleRow(item)
          }
        }
      }
    }
  }

  private func idleRow(_ item: IdleProject) -> some View {
    Button {
      selection = .project(item.project)
    } label: {
      HStack(spacing: Space.lg) {
        Text(store.title(of: item.project)).font(.stim(.headline)).foregroundStyle(Palette.text).lineLimit(1)
        Text(countLabel(item.workspaces, "worktree")).font(.stim(.callout)).foregroundStyle(Palette.tertiary).fixedSize()
        Spacer(minLength: Space.lg)
        if let pullRequest = item.pullRequest {
          Pill(tone: pullRequest.state == "draft" ? .neutral : .brand) {
            Text("PR #\(String(pullRequest.number)) \u{00B7} \(pullRequest.state)")
          }
        }
        if let failed = item.failedBuild {
          Pill(tone: .error) { Text("\(failed.platform == "ios" ? "iOS" : "Android") build failed") }
        }
        if item.errors > 0 {
          Pill(tone: .error) { Text(countLabel(item.errors, "error")) }
        }
        if let date = item.lastActivity {
          Text(Format.age(Date().timeIntervalSince(date))).font(.stim(.callout)).foregroundStyle(Palette.tertiary).fixedSize()
        }
        Image(systemName: "chevron.right").font(.stim(.caption)).foregroundStyle(Palette.tertiary)
      }
      .padding(.horizontal, Space.xl)
      .padding(.vertical, Space.lg)
      .contentShape(Rectangle())
    }
    .buttonStyle(.hoverRow(radius: 0))
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

  private var tips: [TryThisTip] {
    var inputs = TryThisInputs()
    inputs.remoteMachines =
      machines.settings.error == nil
      ? machines.settings.payload.map { $0.entry("remote.machines")?.value.strings ?? [] } : nil
    inputs.hasEASProject = capabilities.values.contains { $0.eas }
    inputs.hasMacosTarget = capabilities.values.contains { $0.macos }
    inputs.phoneApp = FeatureFlags.isEnabled(.phoneApp)
    inputs.workspaces = store.payload?.environments ?? []
    return TryThis.select(inputs: inputs, dismissed: dismissedTips, sidebarTopic: sidebarTopic)
  }

  private func tipsSection(_ tips: [TryThisTip]) -> some View {
    section("Try this") {
      let columns = Array(repeating: GridItem(.flexible(), spacing: Space.xl, alignment: .top), count: tips.count)
      LazyVGrid(columns: columns, alignment: .leading, spacing: Space.xl) {
        ForEach(tips, id: \.self) { tip in
          let prompt = TryThisPrompts.byTip[tip.rawValue] ?? ""
          Card {
            VStack(alignment: .leading, spacing: Space.md) {
              HStack(alignment: .top) {
                Image(systemName: "lightbulb").foregroundStyle(Palette.accent)
                Text(tip.title).font(.stim(.headline)).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                IconButton(systemImage: "xmark", help: "Dismiss this tip") {
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
                Spacer(minLength: 0)
                CopyButton(prompt, title: "Copy prompt", accessibilityLabel: "Copy prompt: \(tip.title)")
              }
            }
            .padding(Space.xl)
          }
        }
      }
    }
  }
}
