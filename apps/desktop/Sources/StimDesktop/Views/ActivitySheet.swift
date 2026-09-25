import StimKit
import SwiftUI

struct ActivitySheet: View {
  @ObservedObject var run: ActionRun
  @EnvironmentObject private var actions: ActionCenter
  @Environment(\.dismiss) private var dismiss
  @State private var confirmingDelete = false
  @State private var idleDuration: String?

  private var isGcPreview: Bool { run.command.arguments == ["gc", "--json"] }

  private var report: Result<GcPreview, Error>? {
    guard isGcPreview, run.exitStatus != nil else { return nil }
    return Result { try GcPreview(json: run.stdout) }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(alignment: .firstTextBaseline) {
        Text(run.title).font(Theme.heading(17))
        Spacer()
        status
      }
      CommandText(command: run.command.shellLine)

      if case .success(let report) = report {
        GcPreviewView(report: report)
        DisclosureGroup("Output") { output.frame(height: 160) }
      } else {
        if case .failure(let failure) = report {
          Label(failure.localizedDescription, systemImage: "xmark.octagon.fill").foregroundStyle(Theme.error)
        }
        output
      }

      HStack {
        if run.isRunning {
          Text("Closing this keeps the command running.").foregroundStyle(Theme.tertiary)
        }
        Spacer()
        if case .success(let report) = report, !report.idleDevices.isEmpty {
          idleMenu(report)
        }
        if case .success(let report) = report {
          Button("Delete\u{2026}", role: .destructive) { confirmingDelete = true }
            .disabled(!report.actionable)
            .confirmationDialog(
              "Delete what stim gc reported?", isPresented: $confirmingDelete, titleVisibility: .visible
            ) {
              Button("Run stim gc --delete", role: .destructive) {
                actions.run("Clean up", StimCommand(["gc", "--delete"], cwd: run.command.cwd), key: ActionCenter.machineKey)
              }
            } message: {
              Text(deleteMessage(report))
            }
        }
        Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
      }
    }
    .font(Theme.body(12))
    .padding(22)
    .frame(width: 720, height: 540)
    .background(Theme.background)
  }

  private func idleMenu(_ report: GcPreview) -> some View {
    Menu("Shut down idle\u{2026}") {
      ForEach(GcPreview.idleDurations, id: \.self) { duration in
        let count = GcPreview.idleSeconds(duration).map { report.idleShutdownCount(atLeast: $0) } ?? 0
        Button("Idle \(duration) or more (\(count))") { idleDuration = duration }
          .disabled(count == 0)
      }
    }
    .fixedSize()
    .help("stim gc --idle <duration> shuts down owned devices with no driver or activity for that long. It never deletes them.")
    .confirmationDialog(
      "Shut down devices idle \(idleDuration ?? "") or more?",
      isPresented: Binding(get: { idleDuration != nil }, set: { if !$0 { idleDuration = nil } }),
      titleVisibility: .visible
    ) {
      if let duration = idleDuration {
        Button("Run stim gc --idle \(duration)") {
          actions.run(
            "Shut down idle devices", StimCommand(["gc", "--idle", duration], cwd: run.command.cwd),
            key: ActionCenter.machineKey)
        }
      }
    } message: {
      Text(
        "Stim shuts down owned simulators and emulators idle that long, like stim stop: they stay assigned and boot again on the next run. It checks each device again first and keeps any that became busy."
      )
    }
  }

  private func deleteMessage(_ report: GcPreview) -> String {
    var text = "Stim reclaims \(report.deletableCount) reported entries"
    if report.reclaimableBytes > 0 {
      text += " (\(ByteCountFormatter.string(fromByteCount: report.reclaimableBytes, countStyle: .file)) measured)"
    }
    return text + ". Stim collects the report again when it runs, so it acts on what it finds then."
  }

  @ViewBuilder private var status: some View {
    if let error = run.launchError {
      Chip(tint: Theme.error) { Text(error) }
    } else if let code = run.exitStatus {
      Chip(tint: code == 0 ? Theme.live : Theme.error) {
        Image(systemName: code == 0 ? "checkmark.circle.fill" : "xmark.octagon.fill")
        Text("Exited \(code)")
      }
    } else {
      Chip(tint: Theme.lavender) {
        ProgressView().controlSize(.mini)
        Text("Running")
      }
    }
  }

  private var output: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 1) {
          ForEach(Array(run.lines.enumerated()), id: \.offset) { index, line in
            Text(line.text.isEmpty ? " " : line.text)
              .foregroundStyle(line.channel == .stderr ? Theme.secondary : Theme.text)
              .frame(maxWidth: .infinity, alignment: .leading)
              .id(index)
          }
        }
        .font(Theme.mono())
        .textSelection(.enabled)
        .padding(10)
      }
      .background(RoundedRectangle(cornerRadius: 8).fill(Theme.screen))
      .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border))
      .onChange(of: run.lines.count) { _, count in
        if count > 0 { proxy.scrollTo(count - 1, anchor: .bottom) }
      }
    }
  }
}

struct GcPreviewView: View {
  var report: GcPreview

  var body: some View {
    if report.sections.isEmpty {
      EmptyState(title: "Nothing to clean up", message: "stim gc found nothing left behind.")
    } else {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          Text(report.actionable ? "stim gc --delete would act on the entries not marked kept." : "Nothing here is deletable.")
            .foregroundStyle(Theme.secondary)
          ForEach(report.sections, id: \.key) { section in
            VStack(alignment: .leading, spacing: 6) {
              HStack(spacing: 8) {
                Text(section.title).font(Theme.heading(13))
                Text("\(section.entries.count)").foregroundStyle(Theme.tertiary)
              }
              ForEach(Array(section.entries.enumerated()), id: \.offset) { _, entry in
                entryRow(entry)
              }
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }

  private func entryRow(_ entry: GcPreview.Entry) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: entry.kept == nil ? "trash" : "lock")
        .foregroundStyle(entry.kept == nil ? Theme.warn : Theme.tertiary)
        .frame(width: 14)
      VStack(alignment: .leading, spacing: 2) {
        Text(entry.label.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
          .font(Theme.mono())
          .foregroundStyle(entry.kept == nil ? Theme.text : Theme.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
        if let kept = entry.kept {
          Text("kept: \(kept)").foregroundStyle(Theme.tertiary).lineLimit(2)
        }
      }
      Spacer()
      if let bytes = entry.bytes, bytes > 0 {
        Text(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file))
          .font(Theme.mono())
          .foregroundStyle(Theme.tertiary)
      }
    }
    .textSelection(.enabled)
  }
}
