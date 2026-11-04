import AppKit
import StimKit
import StimStores
import SwiftUI

struct MachineView: View {
  private enum MachineTab: String, CaseIterable {
    case overview = "Overview"
    case builds = "Builds"
    case storage = "Storage"
  }

  var buildMachines: BuildMachinesModel
  @ObservedObject var status: StatusStore
  var metrics: MetricsStore
  var gc: GcReportStore
  @ObservedObject var storage: StorageStore
  @ObservedObject var pressure: DaemonPressureMonitor
  @ObservedObject var tips: TipCoordinator
  @EnvironmentObject private var actions: ActionCenter
  @Environment(\.openSettings) private var openSettings
  @AppStorage("settingsTab") private var settingsTab = "app"
  @State private var selectedMachine: String?
  @State private var selectedTab: MachineTab = .overview
  @State private var selectedPairing: String?
  @State private var hosted = HostedSessionsModel()
  @ObservedObject private var pairedSessions = PairedServerSessions.shared
  @State private var selection: Set<FreeAction>?
  @State private var confirming: (commands: [StimCommand], items: [String])?
  @State private var removing: WorkspaceStorage?
  @State private var expanded: Set<String> = []
  @State private var width: CGFloat = 1000
  @State private var reportCache = StorageReportCache()

  private static let sizeWidth: CGFloat = 84
  private var compact: Bool { width < 860 }

  private var checkout: String? {
    doctorCheckouts(status.payload?.environments ?? [], project: status.project(ofPath:)).first?.path
  }

  private var machine: String? {
    selectedMachine.flatMap { (buildMachines.entries ?? []).contains($0) ? $0 : nil }
  }

  private var pairing: PairedServers.Entry? {
    selectedPairing.flatMap { id in pairedSessions.entries.first { $0.id == id } }
  }

  var body: some View {
    let report = reportCache.value(
      for: StorageReportInputs(
        environments: status.payload?.environments ?? [],
        unprovisioned: status.payload?.unprovisionedWorktrees ?? [], gc: gc.report, disk: storage.disk,
        paths: storage.paths, projectRoots: status.projects.mapValues(\.root)))
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xxxl) {
        header
        machineChoices
        Divider()
        if pairing == nil, selectedTab == .overview,
          let variant = Tips.emptyState(
            gate: tips.established, machines: buildMachines.entries, settingsError: buildMachines.settings.error,
            selectedMachine: machine, peers: buildMachines.peers)
        {
          BuildMachinesEmptyState(
            add: {
              OpenRequests.shared.addMachine = AddMachineRequest(
                machineID: Tips.preselected(buildMachines.peers, hostedSimulators: false)?.id, hostedSimulators: false)
            }, compact: true, needsTailscale: variant == .tailscale)
        }
        if let failure = buildMachines.settingsFailure {
          Text(failure).font(.stim(.footnote)).foregroundStyle(Palette.secondary).textSelection(.enabled)
        }
        if let error = buildMachines.stats.error {
          Text("Could not load build history: \(error)")
            .font(.stim(.footnote)).foregroundStyle(Palette.secondary).textSelection(.enabled)
        }
        if let pairing {
          PairedMachineSection(
            entry: pairing, session: pairedSessions.sessions[pairing.id], status: status.paired[pairing.id],
            work: ForeignWork.list(status.ownedEnvironments, server: pairing.id))
        } else if let machine {
          MachineBuildMachines(
            model: buildMachines, checkout: checkout, selectedMachine: machine,
            placed: PlacedWork.list(status.ownedEnvironments).filter { $0.isOn(machine) })
        } else {
          MachineHeading(
            icon: "laptopcomputer", title: Host.current().localizedName ?? MachineChoices.thisMachineName,
            subtitle: MachineChoices.thisMachineName
          ) {
            EmptyView()
          }
          tabs
          if let daemon = pressure.daemon { pressureBanner(daemon) }
          switch selectedTab {
          case .overview:
            MachineResourceSummary(
              metrics: metrics, volume: lowestVolume, pressure: pressure.daemon?.pressure, compact: width < 620)
            if width >= 820 {
              HStack(alignment: .top, spacing: Space.xl) {
                NowBand(status: status, metrics: metrics, gc: gc).frame(maxWidth: .infinity)
                cleanupSummary(report).frame(width: 240)
              }
            } else {
              NowBand(status: status, metrics: metrics, gc: gc)
              cleanupSummary(report)
            }
            CapacitySection(status: status)
            HostingSection(sessions: hosted.sessions ?? [], stopping: hosted.stopping) { session in
              Task { await hosted.stop(session) }
            }
            ThisMacPlacements(model: buildMachines, limit: 3)
          case .builds:
            ThisMacPlacements(model: buildMachines, showsEmpty: true)
          case .storage:
            storageHeader
            headline(report)
            if let usage = status.payload?.archivedUsage { ArchivedStorageSection(usage: usage) }
            safeToFree(report)
            projects(report)
            devices(report)
            runtimes(report)
            otherTools(report)
          }
        }
      }
      .padding(.horizontal, PageInset.horizontal).padding(.vertical, compact ? Space.xxl : Space.xxxl)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { width = $0 }
    .task(id: checkout) {
      await buildMachines.refreshTailnet()
      while !Task.isCancelled {
        await buildMachines.refresh(checkout: checkout)
        await hosted.refresh()
        try? await Task.sleep(for: .seconds(60))
      }
    }
    .onChange(of: buildMachines.entries) { _, entries in
      if let selectedMachine, !(entries ?? []).contains(selectedMachine) { self.selectedMachine = nil }
    }
    .onAppear {
      storage.refresh()
      if gc.report == nil { gc.refresh() }
    }
    .confirmationDialog(
      "Free This Space?", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
      titleVisibility: .visible, presenting: confirming
    ) { confirmation in
      Button("Free Disk Space", role: .destructive) {
        actions.run("Free Disk Space", steps: confirmation.commands, key: ActionCenter.machineKey)
      }
    } message: { confirmation in
      let commands: String = confirmation.commands.map {
        "stim " + $0.arguments.filter { $0 != "--json" }.joined(separator: " ")
      }.joined(separator: "\n")
      let message: String =
        confirmation.items.joined(separator: "\n\n")
        + "\n\nstim worktree remove refuses a worktree with uncommitted or unpushed work, and stim gc checks each entry again before it acts."
        + "\n\nCommands:\n"
        + commands
      Text(message)
    }
    .confirmationDialog(
      removing.map { "Remove \(status.names(ofPath: $0.path).title)?" } ?? "Remove worktree?",
      isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
      titleVisibility: .visible, presenting: removing
    ) { workspace in
      Button("Remove worktree", role: .destructive) {
        actions.run(
          "Remove \(status.names(ofPath: workspace.path).title)",
          StimCommand(["worktree", "remove"], cwd: workspace.isCheckout ? workspace.path : workspace.worktreePath))
      }
    } message: { workspace in
      Text(
        "Stim reclaims its build outputs, owned devices and Metro port, then removes a linked worktree's checkout\(workspace.branch.map { " of \($0)" } ?? ""); a source checkout keeps its tree. It refuses when the worktree has uncommitted or unpushed work.\n\nCommand: stim worktree remove"
      )
    }
  }

  private var lowestVolume: DiskVolume? {
    metrics.volumes.min { $0.freeBytes < $1.freeBytes }
  }

  #if DEBUG
    private var previewMachineNames: [String] {
      ["Mac mini", "Mac Studio"].filter { name in
        !(buildMachines.entries ?? []).contains { machineName($0) == name }
      }
    }
  #else
    private var previewMachineNames: [String] { [] }
  #endif

  private var machineChoices: some View {
    MachineChoiceBar(
      groups: MachineChoices.groups(remote: buildMachines.entries ?? [], paired: pairedSessions.entries.map(\.id)),
      selection: choice, previews: previewMachineNames, chip: chip(for:), select: choose
    )
  }

  private func chip(for choice: MachineChoice) -> MachineChip {
    switch choice {
    case .thisMachine:
      return MachineChip(title: MachineChoices.thisMachineName, subtitle: "Local", tone: nil)
    case .remote(let entry):
      let readiness = buildMachines.check(in: checkout)?.statuses.first { $0.machine == entry }?.readiness
      return MachineChip(
        title: machineName(entry), subtitle: readiness?.title ?? "Not checked", tone: readiness?.tone ?? .neutral,
        help: "\(entry): your work placed on this machine")
    case .paired(let id):
      guard let entry = pairedSessions.entries.first(where: { $0.id == id }) else {
        return MachineChip(title: "Machine", subtitle: "", tone: .neutral)
      }
      return MachineChip(
        title: pairedName(entry), subtitle: entry.status.title, tone: entry.status.tone,
        help: "\(pairedName(entry)), viewing: the work its stim-server controls")
    }
  }

  private var tabs: some View {
    HStack(spacing: Space.xxl) {
      ForEach(MachineTab.allCases, id: \.self) { tab in
        Button {
          selectedTab = tab
        } label: {
          Text(tab.rawValue)
            .font(.stim(.callout, weight: selectedTab == tab ? .semibold : .regular))
            .foregroundStyle(selectedTab == tab ? Palette.primary : Palette.secondary)
            .padding(.horizontal, Space.sm)
            .padding(.bottom, Space.lg)
            .overlay(alignment: .bottom) {
              Rectangle().fill(selectedTab == tab ? Palette.primary : Color.clear).frame(height: 2)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(tab.rawValue) tab")
        .accessibilityAddTraits(selectedTab == tab ? .isSelected : [])
      }
      Spacer(minLength: 0)
    }
    .background(alignment: .bottom) { Rectangle().fill(Palette.border).frame(height: 1) }
  }

  private var choice: MachineChoice {
    if let pairing { return .paired(pairing.id) }
    return machine.map { .remote($0) } ?? .thisMachine
  }

  private func choose(_ choice: MachineChoice) {
    switch choice {
    case .remote(let entry):
      selectedMachine = entry
      selectedPairing = nil
    case .paired(let id):
      selectedPairing = id
    case .thisMachine:
      selectedMachine = nil
      selectedPairing = nil
    }
  }

  private func pairedName(_ entry: PairedServers.Entry) -> String {
    pairedSessions.sessions[entry.id]?.name ?? entry.pairing?.name ?? "Machine"
  }

  private var header: some View {
    HStack(alignment: .firstTextBaseline) {
      VStack(alignment: .leading, spacing: Space.xs) {
        Text("Machines").font(.stim(.title))
        Text("Your computers, at a glance.")
          .foregroundStyle(Palette.secondary)
      }
      Spacer()
      Button("Link Machine", systemImage: "plus") {
        settingsTab = "build-machines"
        openSettings()
      }
      .buttonStyle(.stim(.plain, .regular))
      .environment(\.stimButtonAccent, Palette.secondary)
    }
  }

  private var storageHeader: some View {
    HStack(alignment: .firstTextBaseline, spacing: Space.lg) {
      Text("Storage").font(.stim(.headline))
      Spacer()
      if let at = storage.measuredAt, !storage.measuring, !gc.running {
        TimelineView(.periodic(from: .now, by: 30)) { context in
          Text("Measured \(Format.age(context.date.timeIntervalSince(at)))")
            .font(.stim(.caption)).foregroundStyle(Palette.tertiary)
        }
      }
      Button("Refresh", systemImage: "arrow.clockwise") {
        storage.refresh(force: true)
        gc.refresh()
      }
      .buttonStyle(.stim(.plain))
      .environment(\.stimButtonAccent, Palette.secondary)
      .disabled(storage.measuring || gc.running)
    }
  }

  private func cleanupSummary(_ report: StorageReport) -> some View {
    let bytes = FreePlan.bytes(report.free, selected: Set(report.free.map(\.action)))
    let incomplete = report.free.contains { $0.bytes == nil }
    return Card {
      VStack(alignment: .leading, spacing: Space.lg) {
        Text("Storage to reclaim").font(.stim(.headline))
        if gc.report == nil {
          Text(gc.running ? "Measuring..." : "Unavailable").font(.stim(.title))
        } else {
          Text((incomplete ? "\u{2265} " : "") + Format.fileSize(bytes)).font(.stim(.title)).monospacedDigit()
        }
        Text(
          gc.error != nil
            ? "The cleanup report could not be refreshed. Review Storage for details."
            : "Review unused devices, caches and build outputs."
        )
        .font(.stim(.callout)).foregroundStyle(Palette.secondary)
        .fixedSize(horizontal: false, vertical: true)
        Button("Review cleanup") { selectedTab = .storage }
          .buttonStyle(.stim(.primary, .regular))
          .padding(.top, Space.md)
      }
      .padding(Space.xl)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func pressureBanner(_ daemon: DaemonStatus) -> some View {
    Banner(
      tone: daemon.level == "critical" ? .error : daemon.isRaised ? .warning : .neutral,
      icon: daemon.isRaised ? "exclamationmark.triangle.fill" : "gauge.with.dots.needle.33percent"
    ) {
      Text(daemon.headline).font(.stim(.body, weight: .semibold))
      Text(
        daemon.mode == "off"
          ? "daemon.mode is off: nothing reclaims on its own. stim gc --delete runs the pressure ladder now."
          : daemon.running == nil
            ? "No stim-daemon runs in this Stim home now; the next stim start, ios or android starts one."
            : daemon.isRaised
              ? "The stim-daemon reclaims idle workspaces, parked devices and caches each minute until the level is normal."
              : "The stim-daemon measures the machine each minute and reclaims only under pressure."
      )
      .foregroundStyle(Palette.secondary)
      ForEach(daemon.lastActions(3)) { action in
        HStack(spacing: Space.sm) {
          Text(action.title).lineLimit(1).truncationMode(.middle)
          if action.bytes > 0 { Text(Format.fileSize(action.bytes)).foregroundStyle(Palette.secondary) }
          Spacer()
          if let date = action.date {
            Text(date, style: .relative).font(.stim(.footnote)).foregroundStyle(Palette.tertiary)
          }
        }
        .font(.stim(.callout))
        .help(action.detail)
      }
    } trailing: {
      if daemon.isRaised {
        Button("Free Disk Space") { pressure.freeDiskSpace() }
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
    let lowest = lowestVolume
    let disk = pressure.daemon?.pressure?.disk
    let categories: [(DiskCategory, CategoryTotal)] = DiskCategory.allCases.map { ($0, report.total($0)) }
    let total = max(1, categories.map { $0.1.bytes }.reduce(0, +))
    let under = disk == "high" || disk == "critical"
    return Card(clipsContent: false) {
      VStack(alignment: .leading, spacing: Space.lg) {
        HStack(alignment: .firstTextBaseline, spacing: Space.md) {
          Text(lowest.map { Format.fileSize($0.freeBytes) } ?? "\u{2014}")
            .font(.stim(.title))
            .foregroundStyle(under ? Palette.warning : Palette.text)
          VStack(alignment: .leading, spacing: Space.xxs) {
            Text(lowest.map { "free on \($0.name) of \(Format.fileSize($0.totalBytes))" } ?? "free")
              .foregroundStyle(Palette.secondary)
            Text(disk.map { "Disk pressure \($0)" } ?? "Disk pressure unknown until the stim-daemon ticks")
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
                  .help("\(category.title): \(Format.fileSize(value.bytes))")
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
              Text(
                value.complete
                  ? Format.fileSize(value.bytes) : value.bytes == 0 ? "\u{2014}" : "\u{2265} " + Format.fileSize(value.bytes)
              )
              .font(.stim(.footnote, mono: true))
              .foregroundStyle(value.complete ? Palette.text : Palette.tertiary)
              .help(value.complete ? "" : "Some of it is still being measured or could not be sized")
            }
          }
        }
        .font(.stim(.callout))
      }
      .padding(Space.xl)
    }
  }

  @ViewBuilder private var gcMissing: some View {
    if gc.running {
      Text("Waiting for stim gc\u{2026}").foregroundStyle(Palette.tertiary)
    } else if let error = gc.error {
      gcFailed(error)
    } else {
      Text("stim gc has not reported yet.").foregroundStyle(Palette.tertiary)
    }
  }

  private func gcFailed(_ error: String) -> some View {
    Label("stim gc --json failed: \(error)", systemImage: "exclamationmark.triangle")
      .foregroundStyle(Palette.warning)
      .textSelection(.enabled)
  }

  // MARK: Safe to free now

  private func safeToFree(_ report: StorageReport) -> some View {
    let selected = FreePlan.effective(selection ?? FreePlan.defaultSelection(report.free), items: report.free)
    let commands = FreePlan.commands(selected, home: NSHomeDirectory())
    let bytes = FreePlan.bytes(report.free, selected: selected)
    let items = report.free.filter { FreePlan.frees($0.action, selected: selected) }
    return CollapsibleSection("machine.free", title: "Free Disk Space", items: report.free, capped: false) {
      Image(systemName: "trash")
        .iconFont(IconSize.small)
        .foregroundStyle(Palette.tertiary)
        .accessibilityHidden(true)
      Spacer()
      Text("\(items.count) selected")
        .font(.stim(.caption)).foregroundStyle(Palette.secondary)
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
        Button(bytes > 0 ? "Free \(Format.fileSize(bytes))\u{2026}" : "Free space\u{2026}") {
          free(commands, items: items.map { "\(freeTitle($0)): \(abbreviatingHome($0.detail))" })
        }
        .buttonStyle(.stim(commands.isEmpty ? .secondary : .primary))
        .saturation(commands.isEmpty ? 0 : 1)
        .disabled(commands.isEmpty)
        .help(
          commands.isEmpty
            ? "Select items to free space."
            : commands.map { "stim " + $0.arguments.joined(separator: " ") }.joined(separator: "\n"))
      }
    } content: { shown in
      if gc.report == nil {
        gcMissing
      } else if report.free.isEmpty {
        if let error = gc.error, !gc.running { gcFailed(error) }
        Text("stim gc found nothing to free.").foregroundStyle(Palette.tertiary)
      } else {
        if let error = gc.error, !gc.running { gcFailed(error) }
        if commands.isEmpty, actions.active(for: ActionCenter.machineKey) == nil {
          Text("Select items to free space.")
            .font(.stim(.footnote, weight: .medium))
            .foregroundStyle(Palette.secondary)
        }
        Text(
          "Rows marked stim gc are freed together by one stim gc --delete, which also frees the worktree and build outputs rows. Free previews or confirms its commands first."
        )
        .font(.stim(.footnote))
        .foregroundStyle(Palette.tertiary)
        ListSection(shown) { item in freeRow(item, selected: selected) }
      }
      cleanup
    }
  }

  private var cleanup: some View {
    Card {
      HStack(spacing: Space.lg) {
        Image(systemName: "trash").foregroundStyle(Palette.accent).accessibilityHidden(true)
        VStack(alignment: .leading, spacing: Space.xxs) {
          Text("Reclaim What Stim Left Behind")
          Text("Preview the stim gc report, then confirm before anything is deleted.")
            .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
        }
        Spacer()
        let command = StimCommand(["gc", "--json"], cwd: NSHomeDirectory())
        Button("Preview Disk Cleanup") { actions.run("Preview Disk Cleanup", command, key: ActionCenter.machineKey) }
          .buttonStyle(.stim())
          .disabled(actions.active(for: ActionCenter.machineKey) != nil)
          .help(command.displayLine())
      }
      .padding(.horizontal, Space.xl)
      .padding(.vertical, Space.lg)
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
      .accessibilityLabel("Select \(freeTitle(item))")
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

  private func free(_ commands: [StimCommand], items: [String]) {
    if let preview = FreePlan.preview(commands) {
      actions.run("Preview Disk Cleanup", StimCommand(preview, cwd: NSHomeDirectory()), key: ActionCenter.machineKey)
    } else {
      confirming = (commands, items)
    }
  }

  // MARK: Projects

  private func projects(_ report: StorageReport) -> some View {
    CollapsibleSection("machine.projects", title: "Repositories and Worktrees", items: report.repositories) {
      Image(systemName: "folder")
        .iconFont(IconSize.small)
        .foregroundStyle(Palette.tertiary)
        .accessibilityHidden(true)
      Spacer()
    } content: { shown in
      if storage.hasGitHubCLI == false {
        Text("Install the GitHub CLI (gh) to show open pull requests.").font(.stim(.footnote))
          .foregroundStyle(Palette.tertiary)
      }
      if report.repositories.isEmpty {
        Text("stim status reports no workspaces.").foregroundStyle(Palette.tertiary)
      } else {
        Card {
          LazyVStack(spacing: 0) {
            if !compact { columnHeader }
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, repository in
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
          .finiteAccessibilityFrame()
        }
      }
    }
  }

  private var columnHeader: some View {
    HStack(spacing: Space.lg) {
      Text("Repository and Worktree").frame(maxWidth: .infinity, alignment: .leading)
      Text("Lifecycle").frame(width: 130, alignment: .leading)
      Text("node_modules").frame(width: Self.sizeWidth, alignment: .trailing)
      Text("Devices").frame(width: Self.sizeWidth, alignment: .trailing)
      Text("Build Outputs").frame(width: Self.sizeWidth, alignment: .trailing)
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
          .accessibilityHidden(true)
        Text(status.title(of: Project(root: repository.path))).font(.stim(.body, weight: .semibold)).lineLimit(1)
        Text("\(repository.worktrees.count) worktrees").foregroundStyle(Palette.tertiary)
        Spacer()
        totalText(repository.total, complete: repository.totalComplete)
        Color.clear.frame(width: 28)
      }
      .padding(.horizontal, Space.xl)
      .padding(.vertical, Space.md)
    }
    .buttonStyle(.hoverRow(radius: 0))
    .accessibilityValue(open ? "Expanded" : "Collapsed")
    .help(abbreviatingHome(repository.path))
  }

  private func workspaceRow(_ workspace: WorkspaceStorage, nested: Bool) -> some View {
    let names = status.names(ofPath: workspace.path)
    let project = status.project(ofPath: workspace.path)
    let title =
      workspace.worktreePath == project.root && names.title == project.name ? status.title(of: project) : names.title
    let lifecycle = WorktreeLifecycle(
      worktree: workspace.worktree, branch: workspace.branch, pulls: storage.pulls(for: workspace))
    return HStack(spacing: Space.lg) {
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(title).lineLimit(1).truncationMode(.middle)
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
        size(workspace.nodeModules, reason: nodeModulesNote(workspace))
        size(workspace.devices)
          .help(workspace.deviceCount == 0 ? "No owned simulator or emulator" : "\(workspace.deviceCount) owned devices")
        size(workspace.buildOutputs)
          .overlay(alignment: .leading) {
            if case .size = workspace.buildOutputs {
              Image(systemName: workspace.buildOutputsKept == nil ? "trash" : "lock")
                .font(.system(size: 9))
                .foregroundStyle(workspace.buildOutputsKept == nil ? Palette.warning : Palette.tertiary)
                .help(
                  workspace.buildOutputsKept.map { "Kept by stim gc --delete: \(abbreviatingHome($0))" }
                    ?? "stim gc --delete clears these")
            }
          }
        size(workspace.logs)
          .overlay(alignment: .leading) {
            if let trimmed = workspace.logsTrimmed {
              Image(systemName: "scissors").font(.system(size: 9)).foregroundStyle(Palette.warning)
                .help("stim gc --delete trims \(Format.fileSize(trimmed)) from logs over twice the 8 MiB cap")
            } else if let kept = workspace.logsKept {
              Image(systemName: "lock").font(.system(size: 9)).foregroundStyle(Palette.tertiary)
                .help("Logs over the cap, kept by stim gc --delete: \(abbreviatingHome(kept))")
            }
          }
      }
      totalText(workspace.total, complete: workspace.totalComplete)
      Menu("Actions for worktree \(title)", systemImage: "ellipsis.circle") {
        Button("Reveal in Finder") { reveal(workspace.worktreePath) }
        Divider()
        Button(
          "Remove worktree" + (workspace.removable.map { ", frees about \(Format.fileSize($0))" } ?? "")
            + "\u{2026}", role: .destructive
        ) { removing = workspace }
        .disabled(actions.active(for: workspace.path) != nil || workspace.missing || workspace.unprovisioned)
      }
      .labelStyle(.iconOnly)
      .iconFont(IconSize.control)
      .frame(width: 28, height: 24)
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .hoverHighlight()
    }
    .padding(.horizontal, Space.xl)
    .padding(.vertical, Space.md)
  }

  private func breakdown(_ workspace: WorkspaceStorage) -> String {
    let shared = workspace.nodeModulesShared.flatMap { $0 > 0 ? " (\(Format.fileSize($0)) shared)" : nil } ?? ""
    return [
      ("node_modules", workspace.nodeModules), ("devices", workspace.devices), ("outputs", workspace.buildOutputs),
      ("logs", workspace.logs),
    ]
    .compactMap { name, size in
      guard let bytes = size.bytes, bytes > 0 || (name == "node_modules" && !shared.isEmpty) else { return nil }
      return "\(name) \(Format.fileSize(bytes))" + (name == "node_modules" ? shared : "")
    }
    .joined(separator: " \u{00B7} ")
  }

  private func nodeModulesNote(_ workspace: WorkspaceStorage) -> String? {
    guard case .size(let bytes) = workspace.nodeModules else { return nil }
    if workspace.isCheckout {
      return bytes > 0 ? "Counted in full here; worktrees cloned from it share these bytes and count only their own" : nil
    }
    guard let shared = workspace.nodeModulesShared else {
      return bytes > 0 ? "Counts files cloned from other folders in full, so it can be more than this worktree frees" : nil
    }
    return shared > 0
      ? "What removing it frees. Another \(Format.fileSize(shared)) is shared with other folders and not counted."
      : nil
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
        Button {
          URL(string: url).map { _ = NSWorkspace.shared.open($0) }
        } label: {
          Pill(tone: .info) { Text(lifecycle!.title) }
        }
        .buttonStyle(.hoverRow())
        .help(url)
      case .stale:
        Pill(tone: .warning) { Text(lifecycle!.title) }.help("No recorded use for that long")
      case .active:
        Text(workspace.unprovisioned ? "Not warmed" : "Active").foregroundStyle(Palette.tertiary)
      case nil:
        Text(workspace.unprovisioned ? "Not warmed" : gc.report == nil ? "\u{2014}" : "Checkout")
          .foregroundStyle(Palette.tertiary)
          .help(
            workspace.unprovisioned
              ? "A linked worktree stim worktree warm has not set up" : "A source checkout; stim gc never removes it")
      }
    }
  }

  // MARK: Devices

  private func devices(_ report: StorageReport) -> some View {
    CollapsibleSection("machine.devices", title: "Simulators and Emulators", items: report.devices) {
      Image(systemName: "iphone")
        .iconFont(IconSize.small)
        .foregroundStyle(Palette.tertiary)
        .accessibilityHidden(true)
    } content: { shown in
      Text(
        "Stim acts only on devices this Stim home created. The others are listed so you can see their size; manage them in Xcode or Android Studio."
      )
      .font(.stim(.footnote))
      .foregroundStyle(Palette.tertiary)
      ForEach(report.inventoryNotices, id: \.self) { notice in
        Label(notice, systemImage: "exclamationmark.triangle").font(.stim(.footnote)).foregroundStyle(Palette.warning)
      }
      if !report.hasInventory {
        inventoryMissing("simulator and AVD")
      } else {
        Card {
          LazyVStack(spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, device in
              if index > 0 { Rectangle().fill(Palette.border).frame(height: 1) }
              deviceRow(device)
            }
          }
          .finiteAccessibilityFrame()
        }
      }
    }
  }

  @ViewBuilder private func inventoryMissing(_ what: String) -> some View {
    if gc.report == nil {
      gcMissing
    } else {
      Text("Update stim to list every \(what) here.").foregroundStyle(Palette.tertiary)
    }
  }

  private func deviceRow(_ entry: DeviceStorage) -> some View {
    let device = entry.device
    let subtitle = [
      entry.isStim || device.owner == .otherStimHome ? device.model : nil, entry.runtimeTitle,
      compact ? entry.lastUsed.map { "used \(lastUsed($0))" } : nil,
    ]
    .compactMap { $0 }.joined(separator: " \u{00B7} ")
    return HStack(spacing: Space.lg) {
      Image(systemName: device.kind == "ios" ? "iphone" : "smartphone")
        .foregroundStyle(entry.isStim ? Palette.accent : Palette.tertiary)
        .frame(width: 16)
        .accessibilityHidden(true)
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
      Pill(tone: .brand) {
        Text("Stim \u{00B7} \(name)" + (device.slot.map { $0 == "default" ? "" : " (\($0))" } ?? ""))
          .lineLimit(1).truncationMode(.middle)
      }
      .help(device.project.map { abbreviatingHome($0) } ?? "")
    case .parked:
      Pill(tone: .brand) { Text("Stim \u{00B7} parked") }
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
    Format.age(Date().timeIntervalSince(date))
  }

  // MARK: Runtimes

  private func runtimes(_ report: StorageReport) -> some View {
    let unused = report.runtimes.filter(\.unused)
    return CollapsibleSection("machine.runtimes", title: "Runtimes and System Images", items: report.runtimes) {
      Image(systemName: "square.stack.3d.up")
        .iconFont(IconSize.small)
        .foregroundStyle(Palette.tertiary)
        .accessibilityHidden(true)
      if !unused.isEmpty {
        Pill(tone: .warning) {
          Text("\(unused.count) unused \u{00B7} \(Format.fileSize(unused.compactMap(\.size.bytes).reduce(0, +)))")
        }
      }
    } content: { shown in
      Text("Stim never deletes these. Copy the vendor command to remove one no device uses.")
        .font(.stim(.footnote))
        .foregroundStyle(Palette.tertiary)
      if !report.hasInventory {
        inventoryMissing("runtime and system image")
      } else if report.runtimes.isEmpty {
        Text("No simulator runtime or Android system image is installed.").foregroundStyle(Palette.tertiary)
      } else {
        Card {
          LazyVStack(spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, runtime in
              if index > 0 { Rectangle().fill(Palette.border).frame(height: 1) }
              runtimeRow(runtime)
            }
          }
          .finiteAccessibilityFrame()
        }
      }
    }
  }

  private func runtimeRow(_ runtime: RuntimeStorage) -> some View {
    HStack(spacing: Space.lg) {
      Image(systemName: runtime.id.hasPrefix("system-images;") ? "square.stack.3d.up" : "cpu")
        .foregroundStyle(runtime.unused ? Palette.warning : Palette.tertiary)
        .frame(width: 16)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(runtime.title).lineLimit(1)
        if let detail = runtime.detail { Text(detail).font(.stim(.caption)).foregroundStyle(Palette.secondary).lineLimit(1) }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if runtime.unused {
        Pill(tone: .warning) { Text("Unused") }.help("No simulator or emulator uses it")
      } else {
        Text(runtime.deviceCount == 1 ? "1 device" : "\(runtime.deviceCount) devices").foregroundStyle(Palette.secondary)
      }
      size(runtime.size, reason: runtime.size == .notMeasured ? "simctl does not report its size" : nil)
      Group {
        if let command = runtime.command {
          CopyButton(command, variant: runtime.unused ? .primary : .secondary, help: "Copies: \(command)")
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
    CollapsibleSection("machine.otherTools", title: "Other Tool Storage", items: report.unmanaged, capped: false) {
      Image(systemName: "wrench.and.screwdriver")
        .iconFont(IconSize.small)
        .foregroundStyle(Palette.tertiary)
        .accessibilityHidden(true)
    } content: { _ in
      Text("Space Xcode, Gradle and other apps use. Stim never deletes these; clear them from the tool that owns them.")
        .font(.stim(.footnote))
        .foregroundStyle(Palette.tertiary)
      Card {
        VStack(spacing: 0) {
          ForEach(Array(report.unmanaged.enumerated()), id: \.element.id) { index, location in
            if index > 0 { Rectangle().fill(Palette.border).frame(height: 1) }
            HStack(spacing: Space.lg) {
              Image(systemName: "folder").foregroundStyle(Palette.tertiary).frame(width: 16).accessibilityHidden(true)
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
    Text(total.map { (complete ? "" : "\u{2265} ") + Format.fileSize($0) } ?? "\u{2026}")
      .font(.stim(.footnote, mono: true)).fontWeight(.semibold)
      .foregroundStyle(complete ? Palette.text : Palette.tertiary)
      .frame(width: Self.sizeWidth, alignment: .trailing)
      .help(complete ? "" : total == nil ? "Measuring" : "Some parts are not sized yet")
  }

  private func size(_ measurement: DiskSize, reason override: String? = nil) -> some View {
    let text: String
    let reason: String
    switch measurement {
    case .size(let bytes): (text, reason) = (Format.fileSize(bytes), "")
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

private struct StorageReportInputs: Equatable {
  var environments: [Workspace]
  var unprovisioned: [UnprovisionedWorktree]
  var gc: GcReport?
  var disk: DiskMeasurements
  var paths: StoragePaths
  var projectRoots: [String: String]
}

private final class StorageReportCache {
  private var inputs: StorageReportInputs?
  private var report: StorageReport?

  func value(for inputs: StorageReportInputs) -> StorageReport {
    if let report, inputs == self.inputs { return report }
    let report = StorageReport.make(
      environments: inputs.environments, unprovisioned: inputs.unprovisioned, gc: inputs.gc, disk: inputs.disk,
      paths: inputs.paths, projectRoots: inputs.projectRoots)
    self.inputs = inputs
    self.report = report
    return report
  }
}
