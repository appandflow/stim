import StimKit
import SwiftUI

/// Shows one `ActionRun`: a human title and subtitle, the command tucked behind a
/// disclosure, a step list parsed from the CLI's phase lines, a result summary that
/// auto-closes on success, and the raw output tucked under "Show details".
struct ActivitySheet: View {
  @ObservedObject var run: ActionRun
  @EnvironmentObject private var actions: ActionCenter
  @Environment(\.dismiss) private var dismiss
  @State private var confirmingDelete = false
  @State private var idleDuration: String?
  @State private var showsCommand = false
  @State private var showsDetails = false

  private var steps: [ProgressStep] { ActivityProgress.parse(run.lines.map(\.text)) }

  private var deleteArguments: [String]? {
    run.steps.count == 1 ? GcPreview.deleteArguments(after: run.command.arguments) : nil
  }

  private var report: Result<GcPreview, Error>? {
    guard deleteArguments != nil, run.exitStatus != nil else { return nil }
    return Result { try GcPreview(json: run.stdout) }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      header
      commandDisclosure

      if case .success(let report) = report {
        GcPreviewView(report: report)
        DisclosureGroup("Show details", isExpanded: $showsDetails) { output.frame(height: 140) }
      } else if let failure = run.launchError ?? failureMessage {
        Label(abbreviatingHome(failure), systemImage: "xmark.octagon.fill").foregroundStyle(Theme.error)
        progressBody
      } else {
        progressBody
      }

      footer
    }
    .font(Theme.body(12))
    .padding(22)
    .frame(width: 640, height: 500)
    .background(Theme.background)
    .onChange(of: run.exitStatus) { _, status in
      guard status == 0 else { return }
      Task {
        try? await Task.sleep(for: .seconds(2))
        if actions.presented?.id == run.id { dismiss() }
      }
    }
  }

  private var failureMessage: String? {
    guard let status = run.exitStatus, status != 0 else { return nil }
    return steps.last { $0.state == .failed }.map { "\($0.fact.isEmpty ? $0.label : $0.fact)" }
      ?? run.summary
      ?? "Exited \(status)"
  }

  @ViewBuilder private var header: some View {
    HStack(alignment: .top) {
      VStack(alignment: .leading, spacing: 2) {
        Text(headerTitle).font(Theme.heading(17))
        Text(abbreviatingHome(run.command.cwd)).foregroundStyle(Theme.tertiary)
      }
      Spacer()
      status
    }
  }

  private var headerTitle: String {
    guard run.isRunning else { return run.title }
    return Self.gerund(run.title)
  }

  /// A present-tense header for common action verbs, falling back to the plain title.
  private static func gerund(_ title: String) -> String {
    let mapping: [(String, String)] = [
      ("Shut down idle devices", "Shutting down idle devices"),
      ("Preview cleanup", "Previewing cleanup"),
      ("Clean up", "Cleaning up"),
      ("Stop ", "Stopping "),
      ("Reload ", "Reloading "),
      ("Start ", "Starting "),
      ("Remove ", "Removing "),
      ("Warm ", "Warming "),
    ]
    for (prefix, replacement) in mapping {
      if title == prefix.trimmingCharacters(in: .whitespaces) { return replacement.trimmingCharacters(in: .whitespaces) }
      if title.hasPrefix(prefix) { return replacement + title.dropFirst(prefix.count) }
    }
    return title
  }

  private var commandDisclosure: some View {
    DisclosureGroup("Show command", isExpanded: $showsCommand) {
      HStack(alignment: .top, spacing: 8) {
        CommandText(command: run.steps.map { $0.displayLine() }.joined(separator: "\n"))
        Button {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(run.steps.map { $0.shellLine }.joined(separator: "\n"), forType: .string)
        } label: {
          Image(systemName: "doc.on.doc")
        }
        .buttonStyle(.stim())
        .help("Copy the command")
      }
    }
    .font(Theme.body(11.5))
    .foregroundStyle(Theme.secondary)
  }

  @ViewBuilder private var progressBody: some View {
    if let waiting = ActivityProgress.waitingStep(steps) {
      Label(waiting.fact, systemImage: "hourglass").foregroundStyle(Theme.warn)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.warn.opacity(0.12)))
    }
    if steps.isEmpty, run.isRunning {
      workingRow
    } else if !steps.isEmpty {
      stepList
    }
    if let status = run.exitStatus, status == 0 {
      resultSummary
    }
    DisclosureGroup("Show details", isExpanded: $showsDetails) { output.frame(height: 140) }
  }

  private var workingRow: some View {
    TimelineView(.periodic(from: run.startedAt, by: 1)) { context in
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text("Working\u{2026}")
        Text(formatDuration(ms: context.date.timeIntervalSince(run.startedAt) * 1000))
          .font(Theme.mono())
          .foregroundStyle(Theme.tertiary)
      }
      .foregroundStyle(Theme.secondary)
    }
  }

  private var stepList: some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(steps) { step in
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Image(systemName: icon(for: step.state))
            .foregroundStyle(color(for: step.state))
            .frame(width: 14)
          Text(step.fact.isEmpty ? step.label : step.fact)
            .foregroundStyle(step.state == .failed ? Theme.error : Theme.text)
          if let duration = step.duration {
            Text(duration).font(Theme.mono()).foregroundStyle(Theme.tertiary)
          }
        }
      }
    }
  }

  private func icon(for state: ProgressStep.State) -> String {
    switch state {
    case .running: return "arrow.triangle.2.circlepath"
    case .waiting: return "hourglass"
    case .done: return "checkmark.circle.fill"
    case .failed: return "xmark.octagon.fill"
    }
  }

  private func color(for state: ProgressStep.State) -> Color {
    switch state {
    case .running: return Theme.lavender
    case .waiting: return Theme.warn
    case .done: return Theme.live
    case .failed: return Theme.error
    }
  }

  private var resultSummary: some View {
    let facts = steps.filter { $0.state == .done }.map { $0.fact.isEmpty ? $0.label : $0.fact }
    let summary = facts.isEmpty ? run.summary ?? "Done" : facts.joined(separator: ", ")
    return Label(summary, systemImage: "checkmark.circle.fill")
      .foregroundStyle(Theme.live)
  }

  @ViewBuilder private var footer: some View {
    HStack {
      if run.isRunning {
        Text("Closing keeps it running in the background.").foregroundStyle(Theme.tertiary)
      }
      Spacer()
      if case .success(let report) = report, run.command.arguments == ["gc", "--json"], !report.idleDevices.isEmpty {
        idleMenu(report)
      }
      if case .success(let report) = report, let deleteArguments {
        Button("Delete\u{2026}", role: .destructive) { confirmingDelete = true }
          .disabled(!report.actionable)
          .confirmationDialog(
            "Delete what stim gc reported?", isPresented: $confirmingDelete, titleVisibility: .visible
          ) {
            Button("Run stim \(deleteArguments.joined(separator: " "))", role: .destructive) {
              actions.run("Clean up", StimCommand(deleteArguments, cwd: run.command.cwd), key: ActionCenter.machineKey)
            }
          } message: {
            Text(deleteMessage(report))
          }
      }
      if let status = run.exitStatus, status != 0 {
        Button("Retry") { actions.run(run.title, steps: run.steps, key: run.key) }
          .buttonStyle(.stim(.primary))
      }
      Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
    }
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
    if run.launchError != nil {
      Chip(tint: Theme.error) { Text("Failed") }
    } else if let code = run.exitStatus {
      Chip(tint: code == 0 ? Theme.live : Theme.error) {
        Image(systemName: code == 0 ? "checkmark.circle.fill" : "xmark.octagon.fill")
        Text(code == 0 ? "Done" : "Failed")
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
            Text(line.text.isEmpty ? " " : abbreviatingHome(line.text))
              .foregroundStyle(line.channel == .stderr ? Theme.secondary : Theme.text)
              .frame(maxWidth: .infinity, alignment: .leading)
              .id(index)
          }
        }
        .font(Theme.mono())
        .textSelection(.enabled)
        .padding(10)
      }
      .background(RoundedRectangle(cornerRadius: 8).fill(Theme.surface))
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
        Text(abbreviatingHome(entry.label))
          .font(Theme.mono())
          .foregroundStyle(entry.kept == nil ? Theme.text : Theme.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
        if let kept = entry.kept {
          Text("kept: \(abbreviatingHome(kept))").foregroundStyle(Theme.tertiary).lineLimit(2)
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
