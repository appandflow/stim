import StimKit
import SwiftUI

/// Shows one `ActionRun`: a spinner and one line while it runs, then a short summary of what it did. Items it
/// left alone and failures are listed apart from what it did, and the command and raw output sit under Details.
struct ActivitySheet: View {
  @ObservedObject var run: ActionRun
  @EnvironmentObject private var actions: ActionCenter
  @Environment(\.dismiss) private var dismiss
  @State private var confirmingDelete = false
  @State private var idleDuration: String?
  @State private var showsDetails = false
  @State private var showsKept = false

  private var steps: [ProgressStep] { ActivityProgress.parse(run.lines.map(\.text)) }

  private var deleteArguments: [String]? {
    run.steps.count == 1 ? GcPreview.deleteArguments(after: run.command.arguments) : nil
  }

  private var report: Result<GcPreview, Error>? {
    guard deleteArguments != nil, run.exitStatus != nil else { return nil }
    return Result { try GcPreview(json: run.stdout) }
  }

  private var outcome: Result<GcOutcome, Error>? {
    guard run.exitStatus != nil else { return nil }
    return run.gcOutcome
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      header
      content
      if !run.isRunning { details }
      footer
    }
    .font(Theme.body(12))
    .padding(22)
    .frame(width: 560)
    .background(Palette.background)
    .onChange(of: run.exitStatus) { _, status in
      guard status == 0, closesOnSuccess else { return }
      Task {
        try? await Task.sleep(for: .seconds(2))
        if actions.presented?.id == run.id { dismiss() }
      }
    }
  }

  /// A plain successful action closes itself after showing that it finished. A preview and a cleanup
  /// summary stay open to be read.
  private var closesOnSuccess: Bool { deleteArguments == nil && outcome == nil }

  @ViewBuilder private var content: some View {
    if run.isRunning {
      runningView
    } else if let failure = failureMessage {
      failureView(failure)
    } else if case .success(let report) = report {
      GcPreviewView(report: report).frame(height: report.sections.isEmpty ? nil : 360)
    } else if case .success(let outcome) = outcome {
      outcomeView(outcome)
    } else {
      Label(Self.pastTense(run.title), systemImage: "checkmark.circle.fill")
        .font(Theme.body(13, weight: .medium))
        .foregroundStyle(Palette.success)
    }
  }

  @ViewBuilder private var header: some View {
    HStack(alignment: .top) {
      VStack(alignment: .leading, spacing: 2) {
        Text(run.isRunning ? Self.gerund(run.title) : run.title).font(Theme.heading(17))
        if abbreviatingHome(run.command.cwd) != "~" {
          Text(abbreviatingHome(run.command.cwd)).foregroundStyle(Palette.tertiary).lineLimit(1).truncationMode(.middle)
        }
      }
      Spacer()
      status
    }
  }

  private var runningView: some View {
    TimelineView(.periodic(from: run.startedAt, by: 1)) { context in
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 10) {
          ProgressView().controlSize(.small)
          Text(currentStep)
            .foregroundStyle(Palette.text)
            .lineLimit(1)
            .truncationMode(.middle)
          Spacer()
          Text(formatDuration(ms: context.date.timeIntervalSince(run.startedAt) * 1000))
            .font(Theme.mono())
            .foregroundStyle(Palette.tertiary)
        }
        if let waiting = ActivityProgress.waitingStep(steps) {
          Label(abbreviatingHome(waiting.fact), systemImage: "hourglass")
            .foregroundStyle(Palette.warning)
            .lineLimit(2)
        }
      }
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 8).fill(Palette.surface))
    }
  }

  /// The latest progress fact the CLI printed, or a plain "Working" when it prints none.
  private var currentStep: String {
    guard let step = steps.last(where: { $0.state != .failed }) else { return "Working\u{2026}" }
    return abbreviatingHome(step.fact.isEmpty ? step.label : step.fact)
  }

  private var failureMessage: String? {
    if let launchError = run.launchError { return launchError }
    if case .failure(let error) = report { return error.localizedDescription }
    if case .failure(let error as GcPreview.Failure) = outcome, case .refused = error { return error.localizedDescription }
    if case .success = outcome { return nil }
    guard let status = run.exitStatus, status != 0 else { return nil }
    return steps.last { $0.state == .failed }.map { $0.fact.isEmpty ? $0.label : $0.fact }
      ?? run.summary
      ?? "Exited \(status)"
  }

  private func failureView(_ message: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Label(abbreviatingHome(message), systemImage: "xmark.octagon.fill")
        .foregroundStyle(Palette.error)
        .textSelection(.enabled)
      ForEach(steps.filter { $0.label == "remedy" }) { remedy in
        Text(abbreviatingHome(remedy.fact)).foregroundStyle(Palette.secondary).textSelection(.enabled)
      }
    }
  }

  private func outcomeView(_ outcome: GcOutcome) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(outcome.headline, systemImage: outcome.failures > 0 ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
        .font(Theme.body(13, weight: .medium))
        .foregroundStyle(outcome.failures > 0 ? Palette.warning : Palette.success)
      if !outcome.done.isEmpty, outcome.done.count <= 6 {
        VStack(alignment: .leading, spacing: 4) {
          ForEach(outcome.done, id: \.self) { item in itemRow(item, icon: "checkmark", tint: Palette.tertiary) }
        }
      }
      if !outcome.failed.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          Text(outcome.failed.count == 1 ? "1 failed" : "\(outcome.failed.count) failed")
            .font(Theme.heading(13))
            .foregroundStyle(Palette.error)
          ForEach(outcome.failed, id: \.self) { item in itemRow(item, icon: "xmark.octagon.fill", tint: Palette.error) }
        }
      } else if outcome.failures > 0 {
        Text("\(outcome.failures) could not be cleaned up. Open Details for the reason, then run it again.")
          .foregroundStyle(Palette.error)
      }
      if !outcome.kept.isEmpty {
        DisclosureGroup(isExpanded: $showsKept) {
          let rows = VStack(alignment: .leading, spacing: 6) {
            ForEach(outcome.kept, id: \.self) { item in itemRow(item, icon: "minus.circle", tint: Palette.tertiary) }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          if outcome.kept.count > 5 {
            ScrollView { rows }.frame(height: 200)
          } else {
            rows
          }
        } label: {
          Text("\(outcome.kept.count) left alone").foregroundStyle(Palette.secondary)
        }
      }
    }
  }

  private func itemRow(_ item: GcOutcome.Item, icon: String, tint: Color) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: icon).foregroundStyle(tint).frame(width: 14)
      VStack(alignment: .leading, spacing: 2) {
        Text(abbreviatingHome(item.label)).lineLimit(2).truncationMode(.middle)
        if let detail = item.detail {
          Text(abbreviatingHome(detail)).foregroundStyle(Palette.tertiary).lineLimit(3)
        }
      }
      Spacer()
      if let bytes = item.bytes, bytes > 0 {
        Text(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file))
          .font(Theme.mono())
          .foregroundStyle(Palette.tertiary)
      }
    }
    .textSelection(.enabled)
  }

  private var details: some View {
    DisclosureGroup("Details", isExpanded: $showsDetails) {
      VStack(alignment: .leading, spacing: 8) {
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
        output.frame(height: 160)
      }
    }
    .font(Theme.body(11.5))
    .foregroundStyle(Palette.tertiary)
  }

  /// A present-tense header for common action verbs, falling back to the plain title.
  private static func gerund(_ title: String) -> String {
    rewrite(title, [
      ("Shut down idle devices", "Shutting down idle devices"),
      ("Preview cleanup", "Previewing cleanup"),
      ("Reclaim disk space", "Reclaiming disk space"),
      ("Nightly cleanup", "Cleaning up"),
      ("Clean up", "Cleaning up"),
      ("Stop ", "Stopping "),
      ("Reload ", "Reloading "),
      ("Start ", "Starting "),
      ("Remove ", "Removing "),
      ("Warm ", "Warming "),
    ])
  }

  /// The sentence a finished action confirms itself with.
  private static func pastTense(_ title: String) -> String {
    rewrite(title, [
      ("Shut down idle devices", "Shut down idle devices"),
      ("Clean up", "Cleaned up"),
      ("Stop ", "Stopped "),
      ("Reload ", "Reloaded "),
      ("Start ", "Started "),
      ("Remove ", "Removed "),
      ("Warm ", "Warmed "),
    ], fallback: "Done")
  }

  private static func rewrite(_ title: String, _ mapping: [(String, String)], fallback: String? = nil) -> String {
    for (prefix, replacement) in mapping {
      if title == prefix.trimmingCharacters(in: .whitespaces) { return replacement.trimmingCharacters(in: .whitespaces) }
      if title.hasPrefix(prefix) { return replacement + title.dropFirst(prefix.count) }
    }
    return fallback ?? title
  }

  @ViewBuilder private var footer: some View {
    HStack {
      if run.isRunning {
        Text("Closing keeps it running in the background.").foregroundStyle(Palette.tertiary)
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
            Button("Run stim \(deleteArguments.filter { $0 != "--json" }.joined(separator: " "))", role: .destructive) {
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
            "Shut down idle devices", StimCommand(["gc", "--idle", duration, "--json"], cwd: run.command.cwd),
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
      Chip(tint: Palette.error) { Text("Failed") }
    } else if let code = run.exitStatus {
      Chip(tint: code == 0 ? Palette.success : Palette.error) {
        Image(systemName: code == 0 ? "checkmark.circle.fill" : "xmark.octagon.fill")
        Text(code == 0 ? "Done" : "Failed")
      }
    } else {
      Chip(tint: Palette.accent) {
        ProgressView().controlSize(.mini)
        Text("Running")
      }
    }
  }

  private var output: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 1) {
          ForEach(Array(run.logLines.enumerated()), id: \.offset) { index, line in
            Text(line.text.isEmpty ? " " : abbreviatingHome(line.text))
              .foregroundStyle(line.channel == .stderr ? Palette.secondary : Palette.text)
              .frame(maxWidth: .infinity, alignment: .leading)
              .id(index)
          }
        }
        .font(Theme.mono())
        .textSelection(.enabled)
        .padding(10)
      }
      .background(RoundedRectangle(cornerRadius: 8).fill(Palette.surface))
      .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette.border))
      .onAppear {
        if !run.logLines.isEmpty { proxy.scrollTo(run.logLines.count - 1, anchor: .bottom) }
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
            .foregroundStyle(Palette.secondary)
          ForEach(report.sections, id: \.key) { section in
            VStack(alignment: .leading, spacing: 6) {
              HStack(spacing: 8) {
                Text(section.title).font(Theme.heading(13))
                Text("\(section.entries.count)").foregroundStyle(Palette.tertiary)
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
        .foregroundStyle(entry.kept == nil ? Palette.warning : Palette.tertiary)
        .frame(width: 14)
      VStack(alignment: .leading, spacing: 2) {
        Text(abbreviatingHome(entry.label))
          .font(Theme.mono())
          .foregroundStyle(entry.kept == nil ? Palette.text : Palette.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
        if let kept = entry.kept {
          Text("kept: \(abbreviatingHome(kept))").foregroundStyle(Palette.tertiary).lineLimit(2)
        }
      }
      Spacer()
      if let bytes = entry.bytes, bytes > 0 {
        Text(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file))
          .font(Theme.mono())
          .foregroundStyle(Palette.tertiary)
      }
    }
    .textSelection(.enabled)
  }
}
