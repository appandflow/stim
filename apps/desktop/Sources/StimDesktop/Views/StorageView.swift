import AppKit
import StimKit
import SwiftUI

struct StorageView: View {
  @ObservedObject var status: StatusStore
  @ObservedObject var metrics: MetricsStore
  @ObservedObject var storage: StorageStore
  @ObservedObject var autopilot: AutopilotRunner
  @EnvironmentObject private var actions: ActionCenter
  @State private var confirmingMerged = false
  @State private var awaitingMerged = false
  @State private var removing: WorkspaceStorage?

  private static let sizeWidth: CGFloat = 92

  var body: some View {
    let report = StorageReport.make(
      environments: status.payload?.environments ?? [], gc: metrics.gcReport, sizes: storage.sizes,
      paths: storage.paths)
    ScrollView {
      VStack(alignment: .leading, spacing: 28) {
        header
        if let plan = autopilot.pressure { pressureBanner(plan) }
        summary(report)
        workspaces(report)
        stim(report)
        unmanaged(report)
      }
      .padding(28)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .onAppear {
      storage.refresh()
      if metrics.gcReport == nil { metrics.refreshGc() }
    }
    .onChange(of: metrics.gcRunning) { _, running in
      guard !running, awaitingMerged else { return }
      awaitingMerged = false
      confirmingMerged = !(metrics.gcReport?.mergedWorktrees.isEmpty ?? true)
    }
  }

  private var header: some View {
    HStack(alignment: .firstTextBaseline) {
      VStack(alignment: .leading, spacing: 4) {
        Text("Storage").font(Theme.heading(22))
        Text("What Stim workspaces, caches and devices use on disk, and what else fills it.")
          .foregroundStyle(Theme.secondary)
      }
      Spacer()
      if storage.measuring || metrics.gcRunning {
        HStack(spacing: 6) {
          ProgressView().controlSize(.small)
          Text("Measuring in the background").foregroundStyle(Theme.tertiary)
        }
      } else if let at = storage.measuredAt {
        TimelineView(.periodic(from: .now, by: 30)) { context in
          Text("Measured \(formatAgo(context.date.timeIntervalSince(at)))").foregroundStyle(Theme.tertiary)
        }
      }
      Button("Refresh") {
        storage.refresh(force: true)
        metrics.refreshGc()
      }
      .buttonStyle(.stim())
      .disabled(storage.measuring || metrics.gcRunning)
    }
  }

  private func pressureBanner(_ plan: PressurePlan) -> some View {
    HStack(alignment: .top, spacing: 14) {
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.warn).font(.system(size: 18))
      VStack(alignment: .leading, spacing: 4) {
        Text(plan.headline).font(Theme.body(13, weight: .semibold))
        Text(plan.proposal).foregroundStyle(Theme.secondary)
        if plan.belowHardFloor {
          Text("Below the hard floor, stim start, ios and android refuse with STIM_LOW_DISK.")
            .foregroundStyle(Theme.warn)
        }
      }
      Spacer()
      if !plan.isEmpty {
        Button("Do it") { autopilot.runPressurePlan(trigger: .manual, present: true) }
          .buttonStyle(.stim(.primary))
          .help("stim gc --delete")
      }
    }
    .padding(16)
    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.warn.opacity(0.12)))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.warn.opacity(0.35)))
  }

  private func summary(_ report: StorageReport) -> some View {
    let lowest = metrics.volumes.min { $0.availableBytes < $1.availableBytes } ?? autopilot.lowestVolume
    let workspaceBytes = report.workspaces.reduce(Int64(0)) { $0 + $1.total }
    let cacheBytes = report.caches.compactMap(\.bytes).reduce(0, +)
    return HStack(spacing: 14) {
      tile(
        "Free", lowest.map { formatDisk($0.unpurgeableFreeBytes ?? $0.availableBytes) } ?? "\u{2014}",
        detail: lowest.map { "\($0.name), without purgeable space" })
      tile("Workspaces", formatDisk(workspaceBytes), detail: "\(report.workspaces.count) environments")
      tile("Stim caches", formatDisk(cacheBytes), detail: "\(report.caches.count) shared caches")
      VStack(alignment: .leading, spacing: 8) {
        SectionLabel(title: "Reclaimable now")
        Text(metrics.reclaimable.map { formatDisk($0.bytes) } ?? "\u{2014}").font(Theme.heading(20))
          .foregroundStyle(Theme.primary)
        previewButton("Reclaim everything safe\u{2026}", ["gc", "--json"])
          .help("Preview stim gc, then run stim gc --delete after a confirmation")
      }
      .padding(16)
      .frame(maxWidth: .infinity, minHeight: 96, alignment: .topLeading)
      .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
      .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.border))
    }
  }

  private func tile(_ title: String, _ value: String, detail: String?) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionLabel(title: title)
      Text(value).font(Theme.heading(20))
      if let detail { Text(detail).font(Theme.body(11.5)).foregroundStyle(Theme.tertiary).lineLimit(1) }
    }
    .padding(16)
    .frame(maxWidth: .infinity, minHeight: 96, alignment: .topLeading)
    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.border))
  }

  private func workspaces(_ report: StorageReport) -> some View {
    let merged = metrics.gcReport?.mergedWorktrees ?? []
    return VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Text("Workspaces").font(Theme.heading(15))
        Text("\(report.workspaces.count)").foregroundStyle(Theme.tertiary)
        Spacer()
        if storage.hasGitHubCLI == false {
          Text("Install the GitHub CLI (gh) to show open pull requests.").font(Theme.body(11.5))
            .foregroundStyle(Theme.tertiary)
        }
        Button("Remove merged worktrees (\(merged.count))\u{2026}") {
          awaitingMerged = true
          metrics.refreshGc()
        }
          .buttonStyle(.stim(.destructive))
          .disabled(merged.isEmpty || awaitingMerged || actions.active(for: ActionCenter.machineKey) != nil)
          .help("stim worktree remove on each worktree stim gc reports as merged")
          .confirmationDialog(
            "Remove \(merged.count == 1 ? "1 merged worktree" : "\(merged.count) merged worktrees")?",
            isPresented: $confirmingMerged, titleVisibility: .visible
          ) {
            Button("Run stim worktree remove", role: .destructive) { removeMerged(merged, report: report) }
          } message: {
            Text(
              merged.map { PathNames(path: $0.path).title }.joined(separator: ", ")
                + ". stim gc reports each branch as merged into the default branch. stim worktree remove refuses a worktree with uncommitted or unpushed work."
            )
          }
      }
      if report.workspaces.isEmpty {
        Text("stim status reports no workspaces.").foregroundStyle(Theme.tertiary)
      } else {
        Card {
          VStack(spacing: 0) {
            columnHeader
            ForEach(report.workspaces) { workspace in
              Rectangle().fill(Theme.border).frame(height: 1)
              workspaceRow(workspace)
            }
          }
        }
      }
    }
    .confirmationDialog(
      "Remove this worktree?",
      isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
      titleVisibility: .visible, presenting: removing
    ) { workspace in
      Button("Run stim worktree remove", role: .destructive) {
        actions.run("Remove \(PathNames(path: workspace.path).title)", StimCommand(["worktree", "remove"], cwd: workspace.path))
      }
    } message: { workspace in
      Text(
        "Stim reclaims its build outputs, owned devices and Metro port, then removes a linked worktree's checkout\(workspace.branch.map { " of \($0)" } ?? ""); a source checkout keeps its tree. It refuses when the worktree has uncommitted or unpushed work."
      )
    }
  }

  private var columnHeader: some View {
    HStack(spacing: 12) {
      Text("Workspace").frame(maxWidth: .infinity, alignment: .leading)
      Text("Lifecycle").frame(width: 150, alignment: .leading)
      Text("Build outputs").frame(width: Self.sizeWidth, alignment: .trailing)
      Text("node_modules").frame(width: Self.sizeWidth, alignment: .trailing)
      Text("Devices").frame(width: Self.sizeWidth, alignment: .trailing)
      Text("Total").frame(width: Self.sizeWidth, alignment: .trailing)
      Color.clear.frame(width: 28)
    }
    .font(Theme.body(11, weight: .medium))
    .foregroundStyle(Theme.tertiary)
    .padding(.horizontal, 16)
    .padding(.vertical, 8)
  }

  private func workspaceRow(_ workspace: WorkspaceStorage) -> some View {
    let names = PathNames(path: workspace.path)
    let lifecycle = WorktreeLifecycle(
      worktree: workspace.worktree, branch: workspace.branch, pulls: storage.pulls(for: workspace))
    return HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(names.title).lineLimit(1)
        Text(workspace.branch ?? names.subtitle).font(Theme.body(11)).foregroundStyle(Theme.secondary).lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      lifecycleChip(lifecycle, worktree: workspace.worktree).frame(width: 150, alignment: .leading)
      size(workspace.buildOutputs)
        .overlay(alignment: .leading) {
          if workspace.buildOutputs != nil {
            Image(systemName: workspace.buildOutputsKept == nil ? "trash" : "lock")
              .font(.system(size: 9))
              .foregroundStyle(workspace.buildOutputsKept == nil ? Theme.warn : Theme.tertiary)
              .help(workspace.buildOutputsKept.map { "Kept by stim gc --delete: \(abbreviatingHome($0))" } ?? "stim gc --delete clears these")
          }
        }
      size(workspace.nodeModules)
      size(workspace.devices)
        .help(workspace.deviceCount == 0 ? "No owned simulator or emulator" : "\(workspace.deviceCount) owned devices")
      Text(workspace.total > 0 ? formatDisk(workspace.total) : "\u{2014}")
        .font(Theme.mono(11.5)).fontWeight(.semibold)
        .frame(width: Self.sizeWidth, alignment: .trailing)
      Menu {
        Button("Reveal in Finder") { reveal(workspace.worktreePath) }
        Divider()
        Button("Remove worktree\u{2026}", role: .destructive) { removing = workspace }
          .disabled(actions.active(for: workspace.path) != nil)
      } label: {
        Image(systemName: "ellipsis.circle")
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .frame(width: 28)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
  }

  @ViewBuilder
  private func lifecycleChip(_ lifecycle: WorktreeLifecycle?, worktree: GcReport.LinkedWorktree?) -> some View {
    switch lifecycle {
    case .merged:
      Chip(tint: Theme.live) { Text(lifecycle!.title) }.help(abbreviatingHome(worktree?.detail ?? ""))
    case .pullRequest(_, let url):
      Button { URL(string: url).map { _ = NSWorkspace.shared.open($0) } } label: {
        Chip(tint: Theme.remote) { Text(lifecycle!.title) }
      }
      .buttonStyle(.plain)
      .help(url)
    case .stale:
      Chip(tint: Theme.warn) { Text(lifecycle!.title) }.help("No recorded use for that long")
    case .active:
      Text("Active").foregroundStyle(Theme.tertiary)
    case nil:
      Text("\u{2014}").foregroundStyle(Theme.tertiary).help("Not a linked worktree stim gc sweeps")
    }
  }

  private func size(_ bytes: Int64?) -> some View {
    Text(bytes.map(formatDisk) ?? "\u{2014}")
      .font(Theme.mono(11.5))
      .foregroundStyle(bytes == nil ? Theme.tertiary : Theme.text)
      .frame(width: Self.sizeWidth, alignment: .trailing)
  }

  private func removeMerged(_ merged: [GcReport.LinkedWorktree], report: StorageReport) {
    let steps = merged.map { worktree in
      let repository = report.workspaces.first { $0.worktreePath == worktree.path }?.repository
      return StimCommand(["worktree", "remove", worktree.path], cwd: repository ?? NSHomeDirectory())
    }
    actions.run("Remove merged worktrees", steps: steps, key: ActionCenter.machineKey)
  }

  private func stim(_ report: StorageReport) -> some View {
    let outputs = metrics.gcReport?.clearableOutputs ?? []
    return VStack(alignment: .leading, spacing: 10) {
      Text("Stim caches and devices").font(Theme.heading(15))
      Card {
        VStack(spacing: 0) {
          locationRow(
            StorageLocation(
              title: "Build outputs of idle workspaces", path: nil,
              bytes: outputs.compactMap(\.bytes).reduce(0, +),
              detail: outputs.count == 1 ? "1 workspace not in use" : "\(outputs.count) workspaces not in use"),
            icon: "hammer"
          ) {
            previewButton("Clear\u{2026}", ["gc", "--json", "--cache", "workspaces"]).disabled(outputs.isEmpty)
          }
          ForEach(report.caches, id: \.dir) { cache in
            Rectangle().fill(Theme.border).frame(height: 1)
            locationRow(
              StorageLocation(title: cache.name, path: cache.dir, bytes: cache.bytes, detail: cache.note ?? cache.dir),
              icon: "shippingbox"
            ) {
              previewButton("Empty\u{2026}", ["gc", "--json", "--cache", cache.name])
                .disabled(!cache.selectedAlone(among: report.caches))
            }
          }
          if let devices = report.reclaimableDevices {
            Rectangle().fill(Theme.border).frame(height: 1)
            locationRow(devices, icon: "iphone") {
              previewButton("Reclaim everything safe\u{2026}", ["gc", "--json"])
            }
          }
        }
      }
    }
  }

  private func unmanaged(_ report: StorageReport) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Text("Outside Stim").font(Theme.heading(15))
        Text("Information only. Stim never deletes these.").foregroundStyle(Theme.tertiary)
      }
      if report.unmanaged.isEmpty {
        Text(storage.measuring ? "Measuring\u{2026}" : "Not measured yet.").foregroundStyle(Theme.tertiary)
      } else {
        Card {
          VStack(spacing: 0) {
            ForEach(Array(report.unmanaged.enumerated()), id: \.element.id) { index, location in
              if index > 0 { Rectangle().fill(Theme.border).frame(height: 1) }
              locationRow(location, icon: "folder") {
                if let path = location.path {
                  Button("Reveal in Finder") { reveal(path) }
                    .buttonStyle(.stim())
                }
              }
            }
          }
        }
      }
    }
  }

  private func locationRow<Action: View>(
    _ location: StorageLocation, icon: String, @ViewBuilder action: () -> Action
  ) -> some View {
    HStack(spacing: 14) {
      Image(systemName: icon).foregroundStyle(Theme.lavender).frame(width: 18)
      VStack(alignment: .leading, spacing: 3) {
        Text(location.title)
        if let detail = location.detail {
          Text(abbreviatingHome(detail)).font(Theme.body(11.5))
            .foregroundStyle(Theme.secondary).lineLimit(1).truncationMode(.middle)
        }
      }
      Spacer()
      size(location.bytes)
      action().frame(minWidth: 120, alignment: .trailing)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
  }

  @ViewBuilder
  private func previewButton(_ title: String, _ arguments: [String]) -> some View {
    if let active = actions.active(for: ActionCenter.machineKey) {
      Button {
        actions.presented = active
      } label: {
        HStack(spacing: 6) {
          ProgressView().controlSize(.mini)
          Text("Running")
        }
      }
      .buttonStyle(.stim())
    } else {
      Button(title) {
        actions.run("Preview cleanup", StimCommand(arguments, cwd: NSHomeDirectory()), key: ActionCenter.machineKey)
      }
      .buttonStyle(.stim())
      .help("stim \(arguments.joined(separator: " ")), then a confirmation before stim gc --delete")
    }
  }

  private func reveal(_ path: String) {
    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
  }
}
