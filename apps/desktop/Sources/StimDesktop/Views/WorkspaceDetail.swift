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
    let devices = env.devices
    let focused = devices.first { $0.id == focusedID } ?? devices.first
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

  private struct Removal {
    var branch: String?
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        VStack(alignment: .leading, spacing: 8) {
          SectionLabel(title: "Workspace")
          Text(env.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
            .font(Theme.mono())
            .foregroundStyle(Theme.secondary)
            .textSelection(.enabled)
          HStack {
            Button("Reveal in Finder") {
              NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: env.path)])
            }
            Button("Open in Terminal") {
              NSWorkspace.shared.open(
                [URL(fileURLWithPath: env.path)],
                withApplicationAt: URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app"),
                configuration: NSWorkspace.OpenConfiguration())
            }
          }
          .controlSize(.small)
        }

        actionSection

        VStack(alignment: .leading, spacing: 8) {
          SectionLabel(title: "Dev server")
          row("Metro", env.metro.map { metro in
            ":\(metro.port) \(metro.running ? "running" : "stopped")" + (metro.pid.map { " \u{00B7} pid \($0)" } ?? "")
          } ?? "none")
          row("Supervisor", env.supervisor.map { "\($0.mode ?? "unknown") \u{00B7} \($0.healthy == true ? "healthy" : "unhealthy")" } ?? "none")
          if let mb = env.memoryMb, mb > 0 { row("Committed", formatGigabytes(mb: mb)) }
        }

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
          ForEach(env.devices) { device in
            HStack(spacing: 8) {
              StatusDot(color: device.isRunning ? Theme.live : Theme.tertiary, filled: device.isRunning)
              Text(device.slot).font(Theme.body(12, weight: .semibold))
              Text(device.model).foregroundStyle(Theme.secondary).lineLimit(1)
              Spacer()
              Text(device.state).foregroundStyle(Theme.tertiary)
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
              Label(warning, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.warn)
                .textSelection(.enabled)
            }
          }
        }

        VStack(alignment: .leading, spacing: 8) {
          SectionLabel(title: "Errors")
          let errors = env.logs?.errorsSinceMarker ?? 0
          Label(
            errors == 0 ? "No errors since the last marker" : "\(errors) errors since the last marker",
            systemImage: errors == 0 ? "checkmark.circle.fill" : "xmark.octagon.fill"
          )
          .foregroundStyle(errors == 0 ? Theme.live : Theme.error)
          HStack {
            CommandText(command: "stim logs --errors")
            Button("Open logs", action: openLogs).controlSize(.small)
          }
        }
      }
      .font(Theme.body(12))
      .padding(20)
    }
  }

  private var actionSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionLabel(title: "Actions")
      if let active = actions.active(for: env.path) {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text(active.title).lineLimit(1)
          Spacer()
          Button("Show output") { actions.presented = active }
        }
      } else {
        HStack {
          Button("Stop") { actions.run("Stop \(env.names.title)", StimCommand(["stop"], cwd: env.path)) }
            .help("stim stop: halt the dev server and shut the owned devices down")
          Button("Remove worktree\u{2026}", role: .destructive) {
            let path = env.path
            Task {
              let branch = await Task.detached { currentBranch(at: path) }.value
              removal = Removal(branch: branch)
            }
          }
          .help("stim worktree remove")
          if let last = actions.latest(for: env.path) {
            Spacer()
            Button("Last output") { actions.presented = last }
          }
        }
      }
    }
    .controlSize(.small)
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

  private func removalMessage(branch: String?) -> String {
    let path = env.path.replacingOccurrences(of: NSHomeDirectory(), with: "~")
    return """
      Worktree: \(path)
      Branch: \(branch ?? "none (detached HEAD)")

      Stim deletes the worktree, its branch when Stim created it and nothing else uses it, \
      its build artifacts, owned devices and Metro port. It refuses when the worktree holds \
      uncommitted or unpushed work. On the source checkout it reclaims the environment only \
      and leaves the tree in place.
      """
  }

  private func row(_ label: String, _ value: String) -> some View {
    HStack(alignment: .top) {
      Text(label).foregroundStyle(Theme.tertiary).frame(width: 84, alignment: .leading)
      Text(value)
    }
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
