import AppKit
import StimKit
import SwiftUI

struct MachineView: View {
  @ObservedObject var status: StatusStore
  @ObservedObject var metrics: MetricsStore
  @ObservedObject var storage: StorageStore
  @ObservedObject var autopilot: AutopilotRunner
  @EnvironmentObject private var actions: ActionCenter
  @State private var selection: Set<FreeAction>?
  @State private var confirming: [StimCommand]?
  @State private var removing: WorkspaceStorage?
  @State private var expanded: Set<String> = []
  @State private var showsAllDevices = false
  @State private var width: CGFloat = 1000

  private static let sizeWidth: CGFloat = 84
  private static let deviceLimit = 12
  private var compact: Bool { width < 860 }

  var body: some View {
    let report = StorageReport.make(
      environments: status.payload?.environments ?? [], unprovisioned: status.payload?.unprovisionedWorktrees ?? [],
      gc: metrics.gcReport, disk: storage.disk, paths: storage.paths,
      projectRoots: status.projects.mapValues(\.root))
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xxxl) {
        header
        if let plan = autopilot.pressure { pressureBanner(plan) }
        headline(report)
        safeToFree(report)
        projects(report)
        devices(report)
        runtimes(report)
        otherTools(report)
      }
      .padding(compact ? Space.xxl : Space.xxxl)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { width = $0 }
    .onAppear {
      storage.refresh()
      if metrics.gcReport == nil { metrics.refreshGc() }
    }
    .confirmationDialog(
      "Free this space?", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
      titleVisibility: .visible, presenting: confirming
    ) { commands in
      Button(commands.count == 1 ? "Run the command" : "Run \(commands.count) commands", role: .destructive) {
        actions.run("Free disk space", steps: commands, key: ActionCenter.machineKey)
      }
    } message: { commands in
      Text(
        commands.map { "stim " + $0.arguments.filter { $0 != "--json" }.joined(separator: " ") }.joined(separator: "\n")
          + "\n\nstim worktree remove refuses a worktree with uncommitted or unpushed work, and stim gc checks each entry again before it acts."
      )
    }
    .confirmationDialog(
      "Remove this worktree?",
      isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
      titleVisibility: .visible, presenting: removing
    ) { workspace in
      Button("Run stim worktree remove", role: .destructive) {
        actions.run("Remove \(status.names(ofPath: workspace.path).title)", StimCommand(["worktree", "remove"], cwd: workspace.path))
      }
    } message: { workspace in
      Text(
        "Stim reclaims its build outputs, owned devices and Metro port, then removes a linked worktree's checkout\(workspace.branch.map { " of \($0)" } ?? ""); a source checkout keeps its tree. It refuses when the worktree has uncommitted or unpushed work."
      )
    }
  }

  // MARK: Header

  private var header: some View {
    HStack(alignment: .firstTextBaseline) {
      VStack(alignment: .leading, spacing: Space.xs) {
        Text("Machine").font(.stim(.title))
        Text("What uses this Mac's disk, largest first, and what Stim can free.")
          .foregroundStyle(Palette.secondary)
      }
      Spacer()
      if let at = storage.measuredAt, !storage.measuring, !metrics.gcRunning {
        TimelineView(.periodic(from: .now, by: 30)) { context in
          Text("Measured \(formatAgo(context.date.timeIntervalSince(at)))").foregroundStyle(Palette.tertiary)
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
    Banner(tone: .warning, icon: "exclamationmark.triangle.fill") {
      Text(plan.headline).font(.stim(.body, weight: .semibold))
      Text(plan.proposal).foregroundStyle(Palette.secondary)
      if plan.belowHardFloor {
        Text("Below the hard floor, stim start, ios and android refuse with STIM_LOW_DISK.")
          .foregroundStyle(Palette.warning)
      }
    } trailing: {
      if !plan.isEmpty {
        Button("Do it") { autopilot.runPressurePlan(trigger: .manual, present: true) }
          .buttonStyle(.stim(.primary))
          .help("stim gc --delete")
      }
    }
  }

  // MARK: Headline

  private static func color(_ category: DiskCategory) -> Color {
    switch category {
    case .stimDevices: return Palette.primary
    case .stimCaches: return Palette.accent.opacity(0.55)
    case .nodeModules: return Palette.info
    case .otherDevices: return Palette.warning
    case .runtimes: return Palette.error.opacity(0.75)
    case .otherTools: return Palette.tertiary.opacity(0.6)
    }
  }

  private func headline(_ report: StorageReport) -> some View {
    let lowest = metrics.volumes.min { $0.freeBytes < $1.freeBytes } ?? autopilot.lowestVolume
    let budget = autopilot.budget.flatMap { $0.minFree > 0 ? Int64($0.minFree * 1_000_000_000) : nil }
    let categories: [(DiskCategory, CategoryTotal)] = DiskCategory.allCases.map { ($0, report.total($0)) }
    let total = max(1, categories.map { $0.1.bytes }.reduce(0, +))
    let under = lowest.flatMap { volume in budget.map { volume.freeBytes < $0 } } ?? false
    return VStack(alignment: .leading, spacing: Space.lg) {
      HStack(alignment: .firstTextBaseline, spacing: Space.md) {
        Text(lowest.map { formatDisk($0.freeBytes) } ?? "\u{2014}")
          .font(.stim(.title))
          .foregroundStyle(under ? Palette.warning : Palette.text)
        VStack(alignment: .leading, spacing: Space.xxs) {
          Text(lowest.map { "free on \($0.name) of \(formatDisk($0.totalBytes))" } ?? "free")
            .foregroundStyle(Palette.secondary)
          Text(
            budget.map { under ? "Under the \(formatDisk($0)) Stim budget" : "Stim budget \(formatDisk($0)) free" }
              ?? "No Stim disk budget set"
          )
          .font(.stim(.footnote))
          .foregroundStyle(under ? Palette.warning : Palette.tertiary)
        }
        Spacer()
      }
      GeometryReader { proxy in
        HStack(spacing: Space.xxs) {
          ForEach(categories, id: \.0) { category, value in
            if value.bytes > 0 {
              Rectangle()
                .fill(Self.color(category))
                .frame(width: max(2, (proxy.size.width - 12) * CGFloat(value.bytes) / CGFloat(total)))
                .help("\(category.title): \(formatDisk(value.bytes))")
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(height: 14)
      .clipShape(RoundedRectangle(cornerRadius: Radius.small))
      FlowLayout(spacing: Space.xl) {
        ForEach(categories, id: \.0) { category, value in
          HStack(spacing: Space.sm) {
            RoundedRectangle(cornerRadius: 2).fill(Self.color(category)).frame(width: 9, height: 9)
            Text(category.title).foregroundStyle(Palette.secondary)
            Text(value.complete ? formatDisk(value.bytes) : value.bytes == 0 ? "\u{2014}" : "\u{2265} " + formatDisk(value.bytes))
              .font(.stim(.footnote, mono: true))
              .foregroundStyle(value.complete ? Palette.text : Palette.tertiary)
              .help(value.complete ? "" : "Some of it is still being measured or could not be sized")
          }
        }
      }
      .font(.stim(.callout))
    }
    .padding(Space.xl)
    .background(RoundedRectangle(cornerRadius: Radius.card).fill(Palette.surface))
    .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.border))
  }

  // MARK: Safe to free now

  private func safeToFree(_ report: StorageReport) -> some View {
    let selected = FreePlan.effective(selection ?? FreePlan.defaultSelection(report.free), items: report.free)
    let commands = FreePlan.commands(selected, home: NSHomeDirectory())
    let bytes = FreePlan.bytes(report.free, selected: selected)
    return VStack(alignment: .leading, spacing: Space.md) {
      HStack(alignment: .firstTextBaseline, spacing: Space.md) {
        Text("Safe to free now").font(.stim(.headline))
        Text("\(report.free.count)").foregroundStyle(Palette.tertiary)
        Spacer()
        if let active = actions.active(for: ActionCenter.machineKey) {
          Button {
            actions.presented = active
          } label: {
            HStack(spacing: Space.sm) {
              ProgressView().controlSize(.mini)
              Text("Running")
            }
          }
          .buttonStyle(.stim())
        } else {
          Button("Free \(formatDisk(bytes))\u{2026}") { free(commands) }
            .buttonStyle(.stim(.primary))
            .disabled(commands.isEmpty)
            .help(commands.map { "stim " + $0.arguments.joined(separator: " ") }.joined(separator: "\n"))
        }
      }
      if metrics.gcReport == nil {
        Text(metrics.gcRunning ? "Waiting for stim gc\u{2026}" : "stim gc has not reported yet.").foregroundStyle(Palette.tertiary)
      } else if report.free.isEmpty {
        Text("stim gc found nothing to free.").foregroundStyle(Palette.tertiary)
      } else {
        ListSection(report.free) { item in freeRow(item, selected: selected) }
        Text(
          "Rows marked stim gc are freed together by one stim gc --delete, which also frees the worktree and build outputs rows. Free previews or confirms its commands first."
        )
        .font(.stim(.footnote))
        .foregroundStyle(Palette.tertiary)
      }
    }
  }

  private func freeRow(_ item: FreeItem, selected: Set<FreeAction>) -> some View {
    let on = FreePlan.frees(item.action, selected: selected)
    let enabled = FreePlan.canToggle(item.action, selected: selected)
    return HStack(spacing: Space.lg) {
      Toggle(
        isOn: Binding(
          get: { on },
          set: { value in
            var next = selected
            if value { next.insert(item.action) } else { next.remove(item.action) }
            selection = next
          })
      ) { EmptyView() }
      .toggleStyle(.checkbox)
      .labelsHidden()
      .disabled(!enabled)
      .help(enabled ? "" : "stim gc --delete frees this too; uncheck the stim gc rows to choose it alone")
      VStack(alignment: .leading, spacing: Space.xxs) {
        HStack(spacing: Space.sm) {
          Text(freeTitle(item)).lineLimit(1).truncationMode(.middle)
          Pill(tone: .neutral) { Text(actionLabel(item.action)) }
        }
        Text(abbreviatingHome(item.detail)).font(.stim(.footnote)).foregroundStyle(Palette.secondary).lineLimit(1)
          .truncationMode(.middle)
      }
      Spacer()
      size(item.bytes.map(DiskSize.size) ?? .notMeasured, reason: item.bytes == nil ? "A record only, or not sized" : nil)
    }
    .padding(.horizontal, Space.xl)
    .padding(.vertical, Space.md)
    .opacity(on ? 1 : 0.7)
  }

  private func freeTitle(_ item: FreeItem) -> String {
    guard let path = item.path else { return item.title }
    return "\(item.title) of \(status.names(ofPath: path).title)"
  }

  private func actionLabel(_ action: FreeAction) -> String {
    switch action {
    case .gc: return "stim gc"
    case .workspaceOutputs: return "gc --cache workspaces"
    case .cache: return "gc --cache"
    case .removeWorktree: return "worktree remove"
    }
  }

  private func free(_ commands: [StimCommand]) {
    if let preview = FreePlan.preview(commands) {
      actions.run("Preview cleanup", StimCommand(preview, cwd: NSHomeDirectory()), key: ActionCenter.machineKey)
    } else {
      confirming = commands
    }
  }

  // MARK: Projects

  private func projects(_ report: StorageReport) -> some View {
    VStack(alignment: .leading, spacing: Space.md) {
      HStack(spacing: Space.md) {
        Text("Projects").font(.stim(.headline))
        Text("\(report.repositories.count)").foregroundStyle(Palette.tertiary)
        Spacer()
        if storage.hasGitHubCLI == false {
          Text("Install the GitHub CLI (gh) to show open pull requests.").font(.stim(.footnote))
            .foregroundStyle(Palette.tertiary)
        }
      }
      if report.repositories.isEmpty {
        Text("stim status reports no workspaces.").foregroundStyle(Palette.tertiary)
      } else {
        Card {
          VStack(spacing: 0) {
            if !compact { columnHeader }
            ForEach(Array(report.repositories.enumerated()), id: \.element.id) { index, repository in
              if index > 0 || !compact { Rectangle().fill(Palette.border).frame(height: 1) }
              if repository.worktrees.count == 1, let workspace = repository.worktrees.first {
                workspaceRow(workspace, nested: false)
              } else {
                repositoryRow(repository)
                if expanded.contains(repository.id) {
                  ForEach(repository.worktrees) { workspace in
                    Rectangle().fill(Palette.border.opacity(0.6)).frame(height: 1).padding(.leading, Space.xl + Space.xxxl)
                    workspaceRow(workspace, nested: true)
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  private var columnHeader: some View {
    HStack(spacing: Space.lg) {
      Text("Repository and worktree").frame(maxWidth: .infinity, alignment: .leading)
      Text("Lifecycle").frame(width: 130, alignment: .leading)
      Text("node_modules").frame(width: Self.sizeWidth, alignment: .trailing)
      Text("Devices").frame(width: Self.sizeWidth, alignment: .trailing)
      Text("Build outputs").frame(width: Self.sizeWidth, alignment: .trailing)
      Text("Logs").frame(width: Self.sizeWidth, alignment: .trailing)
      Text("Total").frame(width: Self.sizeWidth, alignment: .trailing)
      Color.clear.frame(width: 28)
    }
    .font(.stim(.caption, weight: .medium))
    .foregroundStyle(Palette.tertiary)
    .padding(.horizontal, Space.xl)
    .padding(.vertical, Space.md)
  }

  private func repositoryRow(_ repository: RepositoryStorage) -> some View {
    let open = expanded.contains(repository.id)
    return Button {
      if open { expanded.remove(repository.id) } else { expanded.insert(repository.id) }
    } label: {
      HStack(spacing: Space.lg) {
        Image(systemName: open ? "chevron.down" : "chevron.right")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Palette.tertiary)
          .frame(width: 12)
        Text(repository.name).font(.stim(.body, weight: .semibold)).lineLimit(1)
        Text("\(repository.worktrees.count) worktrees").foregroundStyle(Palette.tertiary)
        Spacer()
        totalText(repository.total, complete: repository.totalComplete)
        Color.clear.frame(width: 28)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help(abbreviatingHome(repository.path))
    .padding(.horizontal, Space.xl)
    .padding(.vertical, Space.md)
  }

  private func workspaceRow(_ workspace: WorkspaceStorage, nested: Bool) -> some View {
    let names = status.names(ofPath: workspace.path)
    let lifecycle = WorktreeLifecycle(
      worktree: workspace.worktree, branch: workspace.branch, pulls: storage.pulls(for: workspace))
    return HStack(spacing: Space.lg) {
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(names.title).lineLimit(1).truncationMode(.middle)
        if compact {
          HStack(spacing: Space.sm) {
            lifecycleChip(lifecycle, workspace: workspace)
            Text(breakdown(workspace)).font(.stim(.caption)).foregroundStyle(Palette.secondary).lineLimit(1)
          }
        } else if let inCheckout = names.inCheckout {
          Text(inCheckout).font(.stim(.caption)).foregroundStyle(Palette.secondary).lineLimit(1)
        }
      }
      .help(abbreviatingHome(workspace.path))
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.leading, nested ? Space.xxxl : 0)
      if !compact {
        lifecycleChip(lifecycle, workspace: workspace).frame(width: 130, alignment: .leading)
        size(workspace.nodeModules)
        size(workspace.devices)
          .help(workspace.deviceCount == 0 ? "No owned simulator or emulator" : "\(workspace.deviceCount) owned devices")
        size(workspace.buildOutputs)
          .overlay(alignment: .leading) {
            if case .size = workspace.buildOutputs {
              Image(systemName: workspace.buildOutputsKept == nil ? "trash" : "lock")
                .font(.system(size: 9))
                .foregroundStyle(workspace.buildOutputsKept == nil ? Palette.warning : Palette.tertiary)
                .help(workspace.buildOutputsKept.map { "Kept by stim gc --delete: \(abbreviatingHome($0))" } ?? "stim gc --delete clears these")
            }
          }
        size(workspace.logs)
          .overlay(alignment: .leading) {
            if let trimmed = workspace.logsTrimmed {
              Image(systemName: "scissors").font(.system(size: 9)).foregroundStyle(Palette.warning)
                .help("stim gc --delete trims \(formatDisk(trimmed)) from logs over twice the 8 MiB cap")
            } else if let kept = workspace.logsKept {
              Image(systemName: "lock").font(.system(size: 9)).foregroundStyle(Palette.tertiary)
                .help("Logs over the cap, kept by stim gc --delete: \(abbreviatingHome(kept))")
            }
          }
      }
      totalText(workspace.total, complete: workspace.totalComplete)
      Menu {
        Button("Reveal in Finder") { reveal(workspace.worktreePath) }
        Divider()
        Button(
          "Remove worktree" + (workspace.removable.map { ", frees about \(formatDisk($0))" } ?? "")
            + "\u{2026}", role: .destructive
        ) { removing = workspace }
        .disabled(actions.active(for: workspace.path) != nil || workspace.missing || workspace.unprovisioned)
      } label: {
        Image(systemName: "ellipsis.circle")
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .frame(width: 28)
    }
    .padding(.horizontal, Space.xl)
    .padding(.vertical, Space.md)
  }

  private func breakdown(_ workspace: WorkspaceStorage) -> String {
    [("node_modules", workspace.nodeModules), ("devices", workspace.devices), ("outputs", workspace.buildOutputs),
     ("logs", workspace.logs)]
      .compactMap { name, size in size.bytes.flatMap { $0 > 0 ? "\(name) \(formatDisk($0))" : nil } }
      .joined(separator: " \u{00B7} ")
  }

  @ViewBuilder
  private func lifecycleChip(_ lifecycle: WorktreeLifecycle?, workspace: WorkspaceStorage) -> some View {
    if workspace.missing {
      Pill(tone: .warning) { Text("Folder gone") }
        .help("stim gc --delete drops this project's record and deletes its owned devices")
    } else {
      switch lifecycle {
      case .merged:
        Pill(tone: .success) { Text(lifecycle!.title) }.help(abbreviatingHome(workspace.worktree?.detail ?? ""))
      case .pullRequest(_, let url):
        Button { URL(string: url).map { _ = NSWorkspace.shared.open($0) } } label: {
          Pill(tone: .info) { Text(lifecycle!.title) }
        }
        .buttonStyle(.plain)
        .help(url)
      case .stale:
        Pill(tone: .warning) { Text(lifecycle!.title) }.help("No recorded use for that long")
      case .active:
        Text(workspace.unprovisioned ? "Not warmed" : "Active").foregroundStyle(Palette.tertiary)
      case nil:
        Text(workspace.unprovisioned ? "Not warmed" : metrics.gcReport == nil ? "\u{2014}" : "Checkout")
          .foregroundStyle(Palette.tertiary)
          .help(workspace.unprovisioned ? "A linked worktree stim worktree warm has not set up" : "A source checkout; stim gc never removes it")
      }
    }
  }

  // MARK: Devices

  private func devices(_ report: StorageReport) -> some View {
    let shown = showsAllDevices ? report.devices : Array(report.devices.prefix(Self.deviceLimit))
    return VStack(alignment: .leading, spacing: Space.md) {
      HStack(spacing: Space.md) {
        Text("Simulators and emulators").font(.stim(.headline))
        Text("\(report.devices.count)").foregroundStyle(Palette.tertiary)
      }
      Text("Stim acts only on devices this Stim home created. The others are listed so you can see their size; manage them in Xcode or Android Studio.")
        .font(.stim(.footnote))
        .foregroundStyle(Palette.tertiary)
      ForEach(report.inventoryNotices, id: \.self) { notice in
        Label(notice, systemImage: "exclamationmark.triangle").font(.stim(.footnote)).foregroundStyle(Palette.warning)
      }
      if !report.hasInventory {
        inventoryMissing
      } else {
        Card {
          VStack(spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, device in
              if index > 0 { Rectangle().fill(Palette.border).frame(height: 1) }
              deviceRow(device)
            }
            if report.devices.count > Self.deviceLimit {
              Rectangle().fill(Palette.border).frame(height: 1)
              Button(showsAllDevices ? "Show the largest \(Self.deviceLimit)" : "Show all \(report.devices.count)") {
                showsAllDevices.toggle()
              }
              .buttonStyle(.plain)
              .foregroundStyle(Palette.primary)
              .padding(Space.md)
            }
          }
        }
      }
    }
  }

  @ViewBuilder private var inventoryMissing: some View {
    if metrics.gcReport == nil {
      Text(metrics.gcRunning ? "Waiting for stim gc\u{2026}" : "stim gc has not reported yet.").foregroundStyle(Palette.tertiary)
    } else {
      Text("Update stim to list every simulator, AVD, runtime and system image here.").foregroundStyle(Palette.tertiary)
    }
  }

  private func deviceRow(_ entry: DeviceStorage) -> some View {
    let device = entry.device
    let subtitle = [entry.isStim || device.owner == .otherStimHome ? device.model : nil, entry.runtimeTitle, compact ? entry.lastUsed.map { "used \(lastUsed($0))" } : nil]
      .compactMap { $0 }.joined(separator: " \u{00B7} ")
    return HStack(spacing: Space.lg) {
      Image(systemName: device.kind == "ios" ? "iphone" : "smartphone")
        .foregroundStyle(entry.isStim ? Palette.accent : Palette.tertiary)
        .frame(width: 16)
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(device.name).lineLimit(1).truncationMode(.middle)
        Text(subtitle).font(.stim(.caption)).foregroundStyle(Palette.secondary).lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .help(device.directory.map { abbreviatingHome($0) } ?? device.id)
      owner(entry).frame(width: compact ? 150 : 200, alignment: .leading)
      if !compact {
        Text(entry.lastUsed.map(lastUsed) ?? "\u{2014}")
          .foregroundStyle(Palette.tertiary)
          .frame(width: 90, alignment: .trailing)
          .help(entry.lastUsed == nil ? "Never booted, or its last use is not recorded" : "Last used")
      }
      size(entry.size, reason: sizeReason(entry))
    }
    .padding(.horizontal, Space.xl)
    .padding(.vertical, Space.md)
  }

  private func sizeReason(_ entry: DeviceStorage) -> String? {
    switch entry.size {
    case .notMeasured: return "Stored outside the AVD folder Stim Desktop sizes"
    case .failed: return entry.device.kind == "ios" ? "simctl did not report its size" : nil
    default: return nil
    }
  }

  @ViewBuilder
  private func owner(_ entry: DeviceStorage) -> some View {
    let device = entry.device
    switch device.owner {
    case .workspace:
      let name = device.project.map { status.names(ofPath: $0).title } ?? "a workspace"
      Pill(tone: .accent) {
        Text("Stim \u{00B7} \(name)" + (device.slot.map { $0 == "default" ? "" : " (\($0))" } ?? ""))
          .lineLimit(1).truncationMode(.middle)
      }
      .help(device.project.map { abbreviatingHome($0) } ?? "")
    case .parked:
      Pill(tone: .accent) { Text("Stim \u{00B7} parked") }
        .help("Kept for reuse by the next workspace; stim gc --delete deletes it")
    case .orphaned:
      Pill(tone: .warning) { Text("Stim \u{00B7} no workspace") }
        .help("This Stim home created it and no workspace uses it; stim gc --delete deletes it")
    case .otherStimHome:
      Pill(tone: .neutral) { Text("Another Stim home") }
        .help("A stim- device this Stim home has no record of creating. Stim lists it and never acts on it.")
    case .user:
      Pill(tone: .neutral) { Text("Yours") }
        .help("Not created by Stim. Stim never changes it; manage it in Xcode or Android Studio.")
    }
  }

  private func lastUsed(_ date: Date) -> String {
    formatAgo(Date().timeIntervalSince(date))
  }

  // MARK: Runtimes

  private func runtimes(_ report: StorageReport) -> some View {
    let unused = report.runtimes.filter(\.unused)
    return VStack(alignment: .leading, spacing: Space.md) {
      HStack(spacing: Space.md) {
        Text("Runtimes and system images").font(.stim(.headline))
        if !unused.isEmpty {
          Pill(tone: .warning) {
            Text("\(unused.count) unused \u{00B7} \(formatDisk(unused.compactMap(\.size.bytes).reduce(0, +)))")
          }
        }
      }
      Text("Stim never deletes these. Copy the vendor command to remove one no device uses.")
        .font(.stim(.footnote))
        .foregroundStyle(Palette.tertiary)
      if !report.hasInventory {
        inventoryMissing
      } else if report.runtimes.isEmpty {
        Text("No simulator runtime or Android system image is installed.").foregroundStyle(Palette.tertiary)
      } else {
        Card {
          VStack(spacing: 0) {
            ForEach(Array(report.runtimes.enumerated()), id: \.element.id) { index, runtime in
              if index > 0 { Rectangle().fill(Palette.border).frame(height: 1) }
              runtimeRow(runtime)
            }
          }
        }
      }
    }
  }

  private func runtimeRow(_ runtime: RuntimeStorage) -> some View {
    HStack(spacing: Space.lg) {
      Image(systemName: runtime.id.hasPrefix("system-images;") ? "square.stack.3d.up" : "cpu")
        .foregroundStyle(runtime.unused ? Palette.warning : Palette.tertiary)
        .frame(width: 16)
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(runtime.title).lineLimit(1)
        if let detail = runtime.detail { Text(detail).font(.stim(.caption)).foregroundStyle(Palette.secondary).lineLimit(1) }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if runtime.unused {
        Pill(tone: .warning) { Text("Unused") }
      } else {
        Text(runtime.deviceCount == 1 ? "1 device" : "\(runtime.deviceCount) devices").foregroundStyle(Palette.secondary)
      }
      size(runtime.size, reason: runtime.size == .notMeasured ? "simctl does not report its size" : nil)
      Group {
        if let command = runtime.command {
          Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(command, forType: .string)
          } label: {
            Label("Copy", systemImage: "doc.on.doc")
          }
          .buttonStyle(.stim(runtime.unused ? .primary : .secondary))
          .help("Copies: \(command)")
        } else {
          Text("\u{2014}").foregroundStyle(Palette.tertiary).help("simctl reports no delete command for it")
        }
      }
      .frame(width: 80, alignment: .trailing)
    }
    .padding(.horizontal, Space.xl)
    .padding(.vertical, Space.md)
  }

  // MARK: Other tools

  private func otherTools(_ report: StorageReport) -> some View {
    VStack(alignment: .leading, spacing: Space.md) {
      Text("Other tools").font(.stim(.headline))
      Text("Space Xcode, Gradle and other apps use. Stim never deletes these; clear them from the tool that owns them.")
        .font(.stim(.footnote))
        .foregroundStyle(Palette.tertiary)
      Card {
        VStack(spacing: 0) {
          ForEach(Array(report.unmanaged.enumerated()), id: \.element.id) { index, location in
            if index > 0 { Rectangle().fill(Palette.border).frame(height: 1) }
            HStack(spacing: Space.lg) {
              Image(systemName: "folder").foregroundStyle(Palette.tertiary).frame(width: 16)
              VStack(alignment: .leading, spacing: Space.xxs) {
                Text(location.title)
                Text(abbreviatingHome(location.detail ?? location.path ?? "")).font(.stim(.caption))
                  .foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.middle)
              }
              Spacer()
              size(location.size)
              if let path = location.path {
                Button("Reveal") { reveal(path) }.buttonStyle(.stim()).frame(width: 80, alignment: .trailing)
              }
            }
            .padding(.horizontal, Space.xl)
            .padding(.vertical, Space.md)
          }
        }
      }
    }
  }

  // MARK: Shared

  private func totalText(_ total: Int64?, complete: Bool) -> some View {
    Text(total.map { (complete ? "" : "\u{2265} ") + formatDisk($0) } ?? "\u{2026}")
      .font(.stim(.footnote, mono: true)).fontWeight(.semibold)
      .foregroundStyle(complete ? Palette.text : Palette.tertiary)
      .frame(width: Self.sizeWidth, alignment: .trailing)
      .help(complete ? "" : total == nil ? "Measuring" : "Some parts are not sized yet")
  }

  private func size(_ measurement: DiskSize, reason override: String? = nil) -> some View {
    let text: String
    let reason: String
    switch measurement {
    case .size(let bytes): (text, reason) = (formatDisk(bytes), "")
    case .absent: (text, reason) = ("None", "Nothing on disk")
    case .measuring: (text, reason) = ("\u{2026}", "Measuring")
    case .failed: (text, reason) = ("Unknown", "Could not be sized; Refresh to try again")
    case .notMeasured: (text, reason) = ("\u{2014}", "Not measured yet")
    }
    return Text(text)
      .font(.stim(.footnote, mono: true))
      .foregroundStyle(measurement.bytes.map { $0 > 0 } == true ? Palette.text : Palette.tertiary)
      .frame(width: Self.sizeWidth, alignment: .trailing)
      .help(override ?? reason)
  }

  private func reveal(_ path: String) {
    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
  }
}
