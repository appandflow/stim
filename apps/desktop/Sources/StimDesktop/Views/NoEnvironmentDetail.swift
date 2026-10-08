import AppKit
import StimKit
import StimStores
import SwiftUI

struct NoEnvironmentDetail: View {
  var worktree: UnprovisionedWorktree
  var cli: Task<StimCLI, Never>
  var apps: [NotSetUpApp]
  var projectName: String?
  @EnvironmentObject private var actions: ActionCenter
  @State private var selectedPath: String?
  @State private var removal: WorktreeRemoval?
  let prefs = SidebarPreferences()

  private var app: NotSetUpApp { apps.first { $0.path == selectedPath } ?? apps[0] }

  private var runKeys: [String] { [worktree.path] + apps.map(\.path).filter { $0 != worktree.path } }

  private var busy: Bool { runKeys.contains { actions.active(for: $0) != nil } }

  private var latestRun: ActionRun? { runKeys.compactMap { actions.latest(for: $0) }.max { $0.startedAt < $1.startedAt } }

  var body: some View {
    VStack(spacing: 0) {
      header
        .padding(.horizontal, Space.xxl)
        .padding(.vertical, Space.md)
      Rectangle().fill(Palette.border).frame(height: 1)
      GeometryReader { geometry in
        ScrollView {
          VStack(spacing: Space.xl) {
            NoDeviceArt()
            Text("Stim Hasn't Run Here Yet").font(.stim(.headline))
            Text(
              "Set up copies dependencies from \(projectName.map { $0 + "'s " } ?? "")main checkout, then runs the app with its own dev server and simulator."
            )
            .font(.stim(.body)).foregroundStyle(Palette.secondary).multilineTextAlignment(.center)
            if apps.count > 1 {
              Picker("App", selection: Binding(get: { app.path }, set: { selectedPath = $0 })) {
                ForEach(apps, id: \.path) { app in
                  Text(app.label ?? "Repository root").tag(app.path)
                }
              }
              .pickerStyle(.menu)
            }
            HStack(spacing: Space.sm) {
              ForEach(Array(app.platforms.enumerated()), id: \.element) { index, platform in
                Button("Run on \(platformName(platform))") {
                  actions.run(
                    "Run \(worktree.names.title) on \(platformName(platform))", steps: setUpSteps([platform], app: app),
                    key: app.path, present: false)
                }
                .buttonStyle(.stim(index == 0 ? .primary : .secondary, .regular))
              }
              if app.platforms.contains("ios") || app.platforms.contains("android") {
                Button("Start dev server") {
                  actions.run(
                    "Start \(worktree.names.title)", steps: setUpSteps(["start"], app: app), key: app.path, present: false)
                }
                .buttonStyle(.stim(.secondary, .regular))
              }
            }
            .disabled(busy)
            facts
          }
          .frame(maxWidth: 460)
          .padding(Space.xxl)
          .frame(maxWidth: .infinity)
          .frame(minHeight: geometry.size.height)
        }
      }
    }
    .navigationTitle(worktree.names.title)
    .confirmationDialog(
      "Remove this worktree?",
      isPresented: Binding(get: { removal != nil }, set: { if !$0 { removal = nil } }),
      titleVisibility: .visible,
      presenting: removal
    ) { _ in
      Button("Run stim worktree remove", role: .destructive) {
        actions.run("Remove \(worktree.names.title)", StimCommand(["worktree", "remove"], cwd: worktree.path))
      }
    } message: { removal in
      Text(worktreeRemovalMessage(path: worktree.path, branch: removal.branch))
    }
  }

  private var header: some View {
    HStack(spacing: Space.md) {
      HStack(spacing: Space.sm) {
        StatusDot(color: Palette.tertiary, filled: false)
        Text("Not set up").font(.stim(.callout, weight: .semibold)).fixedSize()
      }
      if let chip = GitChip(worktree.info) {
        Rectangle().fill(Palette.border).frame(width: 1, height: 14)
        GitChipButton(cli: cli, chip: chip, worktree: worktree.info, workspace: worktree.path)
      }
      Spacer(minLength: Space.md)
      if let run = latestRun {
        NotSetUpRunStatus(run: run)
      }
      Menu {
        WorkspaceActionsMenu(
          kind: .worktree, path: worktree.path, busy: busy,
          removalAllowed: worktreeRemovalAllowed(git: worktree.git),
          onWarmWorktree: {
            actions.run("Warm \(worktree.names.title)", StimCommand(["worktree", "warm"], cwd: worktree.path))
          },
          onRemoveWorktree: { resolveRemovalBranch(at: worktree.path) { removal = WorktreeRemoval(branch: $0) } },
          hidden: prefs.hiddenWorkspaces.paths.contains(worktree.path), canHide: !busy,
          onToggleHidden: { prefs.setHidden(!prefs.hiddenWorkspaces.paths.contains(worktree.path), path: worktree.path) })
      } label: {
        Image(systemName: "ellipsis")
      }
      .menuStyle(.button)
      .menuIndicator(.hidden)
      .buttonStyle(.borderless)
      .fixedSize()
      .help("Worktree actions")
      .accessibilityLabel("Worktree actions")
    }
  }

  private var facts: some View {
    Grid(alignment: .leading, horizontalSpacing: Space.md, verticalSpacing: Space.sm) {
      GridRow(alignment: .firstTextBaseline) {
        Text("Folder").foregroundStyle(Palette.secondary)
        VStack(alignment: .leading, spacing: Space.xs) {
          Text(abbreviatingHome(app.path)).font(.stim(.footnote, mono: true)).textSelection(.enabled)
          Button("Show in Finder") {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: app.path)])
          }
          .buttonStyle(.link)
        }
      }
      if let repository = worktree.repository {
        GridRow(alignment: .firstTextBaseline) {
          Text("Repository").foregroundStyle(Palette.secondary)
          Text(abbreviatingHome(repository)).font(.stim(.footnote, mono: true)).textSelection(.enabled)
        }
      }
      GridRow(alignment: .firstTextBaseline) {
        Text("Branch").foregroundStyle(Palette.secondary)
        Text(worktree.branch ?? "Detached HEAD").textSelection(.enabled)
      }
    }
    .font(.stim(.footnote))
  }
}

private struct NotSetUpRunStatus: View {
  @ObservedObject var run: ActionRun
  @EnvironmentObject private var actions: ActionCenter

  var body: some View {
    if run.isRunning {
      ProgressView().controlSize(.small)
      Text(run.statusLine ?? run.title).font(.stim(.footnote)).foregroundStyle(Palette.secondary).lineLimit(1)
      Button("Show output") { actions.presented = run }.buttonStyle(.stim(.plain)).fixedSize()
    } else if run.needsAttention {
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Palette.error)
      Text("\(run.title) failed").font(.stim(.footnote)).foregroundStyle(Palette.secondary).lineLimit(1)
      Button("Show output") { actions.presented = run }.buttonStyle(.stim(.plain)).fixedSize()
    }
  }
}
