import AppKit
import StimKit
import SwiftUI

struct WorkspaceDetail: View {
  var env: Workspace
  @State private var focusedID: String?
  @State private var stats: ProjectStats?

  var body: some View {
    let devices = env.devices
    let focused = devices.first { $0.id == focusedID } ?? devices.first
    HStack(spacing: 0) {
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
          DeviceTile(device: focused, screenHeight: 640)
        } else {
          EmptyState(title: "No devices", message: "This workspace has no recorded simulator or emulator.")
        }
        Spacer(minLength: 0)
      }
      .padding(24)
      .frame(maxWidth: .infinity, maxHeight: .infinity)

      Rectangle().fill(Theme.border).frame(width: 1)
      Inspector(env: env, stats: stats)
        .frame(width: 360)
        .background(Theme.sidebar)
    }
    .navigationTitle(env.names.title)
    .task(id: env.path) {
      let path = env.path
      stats = await Task.detached { try? StimCLI.stats(workspace: path) }.value
    }
  }
}

struct Inspector: View {
  var env: Workspace
  var stats: ProjectStats?

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

        VStack(alignment: .leading, spacing: 8) {
          SectionLabel(title: "Dev server")
          row("Metro", env.metro.map { metro in
            ":\(metro.port) \(metro.running ? "running" : "stopped")" + (metro.pid.map { " \u{00B7} pid \($0)" } ?? "")
          } ?? "none")
          row("Supervisor", env.supervisor.map { "\($0.mode ?? "unknown") \u{00B7} \($0.healthy == true ? "healthy" : "unhealthy")" } ?? "none")
          if let mb = env.memoryMb, mb > 0 { row("Memory", formatGigabytes(mb: mb)) }
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
          CommandText(command: "stim logs --errors")
        }
      }
      .font(Theme.body(12))
      .padding(20)
    }
  }

  private func row(_ label: String, _ value: String) -> some View {
    HStack(alignment: .top) {
      Text(label).foregroundStyle(Theme.tertiary).frame(width: 84, alignment: .leading)
      Text(value)
    }
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
