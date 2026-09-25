import AppKit
import StimKit
import SwiftUI

enum DetailTab: Hashable {
  case device
  case logs
}

struct WorkspaceDetail: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  var usage: UsageHistory?
  @Binding var focusedID: String?
  @Binding var tab: DetailTab
  @Binding var logQuery: LogQuery
  var openLogs: () -> Void
  @State private var stats: ProjectStats?
  @State private var takenOver: Set<String> = []

  var body: some View {
    let devices = env.orderedDevices
    let focused = devices.first { $0.id == focusedID } ?? env.devices.first
    HStack(spacing: 0) {
      VStack(spacing: 0) {
        Picker("View", selection: $tab) {
          Text("Device").tag(DetailTab.device)
          Text("Logs").tag(DetailTab.logs)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
        .padding(.vertical, 12)
        Rectangle().fill(Theme.border).frame(height: 1)
        switch tab {
        case .device: deviceView(devices: devices, focused: focused)
        case .logs: LogsView(cli: cli, env: env, query: $logQuery)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)

      Rectangle().fill(Theme.border).frame(width: 1)
      Inspector(env: env, usage: usage, stats: stats, openLogs: openLogs)
        .frame(width: 360)
        .background(Theme.sidebar)
    }
    .navigationTitle(env.names.title)
    .task(id: env.path) {
      let path = env.path
      let cli = await cli.value
      stats = await Task.detached { try? cli.stats(workspace: path) }.value
    }
  }

  private func deviceView(devices: [DeviceRef], focused: DeviceRef?) -> some View {
    VStack(spacing: 16) {
      if devices.count > 1 {
        Picker("Device", selection: Binding(get: { focused?.id }, set: { focusedID = $0 })) {
          ForEach(devices) { device in Text(device.slot).tag(Optional(device.id)) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
      }
      if let focused {
        if focused.isInteractive {
          Toggle("Take over", isOn: Binding(
            get: { takenOver.contains(focused.id) },
            set: { on in if on { takenOver.insert(focused.id) } else { takenOver.remove(focused.id) } }
          ))
          .toggleStyle(.switch)
          .controlSize(.small)
          .help("Send your clicks, trackpad scrolls and keys to this device.")
        }
        DeviceTile(
          device: focused, screenHeight: 640,
          interactive: focused.isRunning && takenOver.contains(focused.id), workspace: env.path,
          build: env.runningBuild(for: focused))
        AgentFeed(cli: cli, workspace: env.path, device: focused)
          .id(focused.id)
          .frame(maxWidth: 520)
      } else {
        EmptyState(title: "No devices", message: "This workspace has no recorded simulator or emulator.")
      }
      Spacer(minLength: 0)
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

struct Inspector: View {
  var env: Workspace
  var usage: UsageHistory?
  var stats: ProjectStats?
  var openLogs: () -> Void
  @EnvironmentObject private var actions: ActionCenter
  @State private var removal: Removal?
  @State private var confirmingStop = false
  @State private var confirmingStopDevice: DeviceRef?
  @AppStorage(AppPreferences.Key.editorBundleID) private var editorID = ""
  @AppStorage(AppPreferences.Key.terminalBundleID) private var terminalID = ""

  private func chosen(_ preferred: String, from apps: [ExternalApp]) -> ExternalApp? {
    ExternalApp.choose(preferred, from: apps) { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) != nil }
  }

  private func open(_ path: String, in app: ExternalApp) {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: app.bundleID) else { return }
    NSWorkspace.shared.open(
      [URL(fileURLWithPath: path)], withApplicationAt: url, configuration: NSWorkspace.OpenConfiguration())
  }

  private struct Removal {
    var branch: String?
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        statusCard

        if let usage {
          VStack(alignment: .leading, spacing: 8) {
            SectionLabel(title: "Resources \u{00B7} \(usage.latest.processCount) processes")
            HStack(alignment: .top, spacing: 10) {
              usageCard(
                "CPU", usage.latest.cpuPercent.map(formatPercent) ?? "--", values: usage.cpu, minimumPeak: 100)
              usageCard(
                "Resident memory", formatMemory(usage.latest.residentBytes), values: usage.resident,
                minimumPeak: 1_073_741_824)
            }
          }
        }

        VStack(alignment: .leading, spacing: 8) {
          SectionLabel(title: "Devices")
          ForEach(env.orderedDevices) { device in
            HStack(spacing: 8) {
              StatusDot(color: device.isRunning ? Theme.live : Theme.tertiary, filled: device.isRunning)
              Text(device.slot).font(Theme.body(12, weight: .semibold))
              Text(device.model).foregroundStyle(Theme.secondary).lineLimit(1)
              Spacer()
              Text(device.state).foregroundStyle(Theme.tertiary)
              if device.isRunning {
                deviceStopButton(device)
              }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.surface))
          }
        }

        if let project = stats?.project, project.ios != nil || project.android != nil {
          VStack(alignment: .leading, spacing: 8) {
            SectionLabel(title: "Build cache \u{00B7} project")
            HStack(alignment: .top, spacing: 10) {
              if let ios = project.ios { statCard("iOS", ios) }
              if let android = project.android { statCard("Android", android) }
            }
          }
        }

        if !env.warnings.isEmpty {
          VStack(alignment: .leading, spacing: 8) {
            SectionLabel(title: "Warnings")
            ForEach(env.warnings, id: \.self) { warning in
              Label(abbreviatingHome(warning), systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.warn)
                .textSelection(.enabled)
            }
          }
        }
      }
      .font(Theme.body(12))
      .padding(20)
    }
    .confirmationDialog(
      "Stop this remote session?",
      isPresented: Binding(get: { confirmingStopDevice != nil }, set: { if !$0 { confirmingStopDevice = nil } }),
      titleVisibility: .visible,
      presenting: confirmingStopDevice
    ) { device in
      Button("Run stim stop", role: .destructive) {
        actions.run("Stop \(device.slot)", stopCommand(for: device, cwd: env.path))
      }
    } message: { _ in
      Text(
        "stim stop ends the billable remote session and halts the workspace's dev server and devices. The session cannot be resumed."
      )
    }
  }

  @ViewBuilder
  private func deviceStopButton(_ device: DeviceRef) -> some View {
    let isRemote = { if case .remote = device { return true } else { return false } }()
    Button("Stop") {
      if isRemote {
        confirmingStopDevice = device
      } else {
        actions.run("Stop \(device.slot)", stopCommand(for: device, cwd: env.path))
      }
    }
    .controlSize(.small)
    .disabled(actions.active(for: env.path) != nil)
    .help(
      isRemote
        ? "stim stop: ends the billable remote session with the rest of the workspace"
        : "stim stop --slot \(device.slot): stops every device in this slot, keeping the shared server and other slots running"
    )
  }

  private var statusCard: some View {
    let errors = env.logs?.errorsSinceMarker ?? 0
    let metroHealthy = env.metro?.running == true && env.supervisor?.healthy != false
    return VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        if let branch = env.worktree?.branch {
          Text(branch).font(Theme.body(12, weight: .semibold)).lineLimit(1)
        }
        if let folder = pathInCheckout(env.path, worktree: env.worktree?.path) {
          Text(folder).font(Theme.mono()).foregroundStyle(Theme.secondary).lineLimit(1).truncationMode(.middle)
        }
        Spacer(minLength: 0)
        actionsMenu
      }
      HStack(spacing: 6) {
        if let metro = env.metro {
          Chip(tint: metroHealthy ? Theme.live : Theme.error) {
            Text("Metro :\(String(metro.port)) \u{00B7} \(metro.running ? (metroHealthy ? "healthy" : "unhealthy") : "stopped")")
          }
          .help(env.supervisor.map { "\($0.mode ?? "supervisor") \u{00B7} \($0.healthy == true ? "healthy" : "unhealthy")" } ?? "")
        }
        if let mb = env.memoryMb, mb > 0 {
          Chip { Text(formatGigabytes(mb: mb)) }.help("Committed memory estimate from stim status")
        }
        if env.logs != nil {
          Button(action: openLogs) {
            Chip(tint: errors > 0 ? Theme.error : nil) { Text(errors == 1 ? "1 error" : "\(errors) errors") }
          }
          .buttonStyle(.plain)
          .help("Open the logs filtered to errors")
        }
      }
      if let active = actions.active(for: env.path) {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text(active.title).lineLimit(1)
          Spacer()
          Button("Show output") { actions.presented = active }
        }
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(Theme.surface))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border))
    .controlSize(.small)
  }

  private var actionsMenu: some View {
    Menu {
      Button("Open logs", systemImage: "text.alignleft", action: openLogs)
      Button("Copy path", systemImage: "doc.on.doc") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(env.path, forType: .string)
      }
      Button("Reveal in Finder", systemImage: "folder") {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: env.path)])
      }
      if let editor = chosen(editorID, from: ExternalApp.editors) {
        Button("Open in \(editor.name)", systemImage: "chevron.left.forwardslash.chevron.right") { open(env.path, in: editor) }
      }
      if let terminal = chosen(terminalID, from: ExternalApp.terminals) {
        Button("Open in \(terminal.name)", systemImage: "terminal") { open(env.path, in: terminal) }
      }
      if let last = actions.latest(for: env.path) {
        Button("Last output", systemImage: "doc.plaintext") { actions.presented = last }
      }
      Divider()
      Button("Stop", systemImage: "stop.circle") {
        if env.remoteDevices?.isEmpty == false {
          confirmingStop = true
        } else {
          stop()
        }
      }
      .disabled(actions.active(for: env.path) != nil)
      Button("Remove worktree\u{2026}", systemImage: "trash", role: .destructive) {
        let path = env.path
        Task {
          let branch = await Task.detached { currentBranch(at: path) }.value
          removal = Removal(branch: branch)
        }
      }
      .disabled(actions.active(for: env.path) != nil)
    } label: {
      Image(systemName: "ellipsis")
    }
    .menuStyle(.button)
    .menuIndicator(.hidden)
    .buttonStyle(.borderless)
    .fixedSize()
    .help("Workspace actions")
    .confirmationDialog("Stop this workspace?", isPresented: $confirmingStop, titleVisibility: .visible) {
      Button("Run stim stop", role: .destructive) { stop() }
    } message: {
      Text("This also ends the workspace's billable EAS Simulator session.")
    }
    .confirmationDialog(
      "Remove this worktree?",
      isPresented: Binding(get: { removal != nil }, set: { if !$0 { removal = nil } }),
      titleVisibility: .visible,
      presenting: removal
    ) { _ in
      Button("Run stim worktree remove", role: .destructive) {
        actions.run("Remove \(env.names.title)", StimCommand(["worktree", "remove"], cwd: env.path))
      }
    } message: { removal in
      Text(removalMessage(branch: removal.branch))
    }
  }

  private func stop() {
    actions.run("Stop \(env.names.title)", StimCommand(["stop"], cwd: env.path))
  }

  private func removalMessage(branch: String?) -> String {
    let path = abbreviatingHome(env.path)
    return """
      Worktree: \(path)
      Branch: \(branch ?? "none (detached HEAD)")

      Stim deletes the worktree, its branch when Stim created it and nothing else uses it, \
      its build artifacts, owned devices and Metro port. It refuses when the worktree holds \
      uncommitted or unpushed work. On the source checkout it reclaims the environment only \
      and leaves the tree in place.
      """
  }

  private func usageCard(_ title: String, _ value: String, values: [Double], minimumPeak: Double) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title).foregroundStyle(Theme.secondary)
      Text(value).font(Theme.heading(22))
      Sparkline(values: values, minimumPeak: minimumPeak).frame(height: 32)
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(Theme.surface))
  }

  private func statCard(_ title: String, _ platform: ProjectStats.Platform) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title).foregroundStyle(Theme.secondary)
      Text("\(Int((platform.hitRate * 100).rounded()))%").font(Theme.heading(22))
      ProgressView(value: platform.hitRate).tint(Theme.lavender)
      Text("\(platform.hits) hits \u{00B7} \(platform.misses) misses").foregroundStyle(Theme.secondary)
      if let cold = platform.lastColdBuildMs {
        Text("Last cold \(formatDuration(ms: cold))").foregroundStyle(Theme.secondary)
      }
      if let saved = platform.timeSavedMs {
        Text("Saved \(formatDuration(ms: saved))").foregroundStyle(Theme.primary)
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(Theme.surface))
  }
}
