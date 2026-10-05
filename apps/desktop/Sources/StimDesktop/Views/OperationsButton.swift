import StimKit
import StimStores
import SwiftUI

struct OperationsButton: View {
  @ObservedObject var log: OperationLog
  let actions: ActionCenter
  let store: StatusStore
  var arrowEdge: Edge = .top
  @State private var shown = false

  var body: some View {
    if !log.runs.isEmpty {
      let running = log.running.count
      let attention = log.attentionCount
      Button {
        shown.toggle()
      } label: {
        HStack(spacing: Space.xxs) {
          if running > 0 {
            ProgressView().controlSize(.mini).scaleEffect(0.8).frame(width: 14, height: 14)
            Text("\(running)").textStyle(.caption2, weight: .medium)
          } else {
            Image(systemName: "clock.arrow.circlepath").font(.system(size: 12, weight: .medium))
          }
        }
        .padding(.horizontal, running > 0 ? Space.sm : 0)
        .overlay(alignment: .topTrailing) {
          if attention > 0 {
            Circle().fill(Palette.error).frame(width: 7, height: 7).offset(x: 1, y: 1)
          }
        }
      }
      .nativeIconStyle(tint: running > 0 ? Palette.accent : Palette.secondary, active: shown)
      .help(Self.tooltip(running: running, attention: attention))
      .accessibilityLabel("Operations")
      .accessibilityValue(Self.summary(running: running, attention: attention))
      .popover(isPresented: $shown, arrowEdge: arrowEdge) {
        OperationsList(log: log) { run in
          shown = false
          DispatchQueue.main.async { actions.presented = run }
        } workspace: { run in
          Self.workspaceName(of: run, store: store)
        }
      }
      .onChange(of: shown) { log.markAllSeen() }
    }
  }

  static func summary(running: Int, attention: Int) -> String {
    var parts: [String] = []
    if running > 0 { parts.append("\(running) running") }
    if attention > 0 { parts.append("\(attention) failed") }
    return parts.isEmpty ? "Recent operations" : parts.joined(separator: ", ")
  }

  static func tooltip(running: Int, attention: Int) -> String {
    summary(running: running, attention: attention) + " \u{2014} click to show"
  }

  @MainActor static func workspaceName(of run: ActionRun, store: StatusStore) -> String? {
    let cwd = run.command.cwd
    return abbreviatingHome(cwd) == "~" ? nil : store.names(ofPath: cwd).title
  }
}

private struct OperationsList: View {
  @ObservedObject var log: OperationLog
  var open: (ActionRun) -> Void
  var workspace: (ActionRun) -> String?

  var body: some View {
    let running = log.running
    let finished = log.runs.filter { !$0.isRunning }
    ScrollView {
      VStack(alignment: .leading, spacing: Space.md) {
        if running.isEmpty && finished.isEmpty {
          Text("No operations yet").foregroundStyle(Palette.tertiary)
        }
        section("Running", running)
        section("Recent", finished)
      }
      .padding(Space.md)
    }
    .frame(width: 340)
    .frame(maxHeight: 420)
    .fixedSize(horizontal: false, vertical: true)
    .background(Palette.background)
  }

  @ViewBuilder private func section(_ title: String, _ runs: [ActionRun]) -> some View {
    if !runs.isEmpty {
      VStack(alignment: .leading, spacing: Space.xs) {
        SectionLabel(title: title).padding(.horizontal, Space.md)
        ForEach(runs) { run in
          OperationRow(run: run, workspace: workspace(run)) { open(run) }
        }
      }
    }
  }
}

private struct OperationRow: View {
  @ObservedObject var run: ActionRun
  var workspace: String?
  var open: () -> Void

  var body: some View {
    Button(action: open) {
      HStack(alignment: .top, spacing: Space.md) {
        glyph.frame(width: 16, height: 16)
        VStack(alignment: .leading, spacing: Space.xxs) {
          Text(run.title).textStyle(.footnote, weight: .medium).foregroundStyle(Palette.text).lineLimit(1)
          HStack(spacing: Space.sm) {
            if let workspace { Text(workspace).lineLimit(1) }
            when
          }
          .textStyle(.caption2)
          .foregroundStyle(Palette.tertiary)
          if let line = run.statusLine {
            Text(abbreviatingHome(line))
              .textStyle(.caption2)
              .foregroundStyle(run.needsAttention ? Palette.error : Palette.secondary)
              .lineLimit(1)
              .truncationMode(.middle)
          }
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, Space.md)
      .padding(.vertical, Space.sm)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .buttonStyle(.hoverRow())
    .accessibilityLabel("\(run.title), \(statusWord)" + (workspace.map { ", \($0)" } ?? ""))
    .accessibilityValue(run.statusLine ?? "")
    .accessibilityHint("Shows its output")
  }

  @ViewBuilder private var glyph: some View {
    if run.isRunning {
      ProgressView().controlSize(.mini)
    } else if run.launchError != nil || run.exitStatus != 0 {
      Image(systemName: "xmark.octagon.fill").foregroundStyle(Palette.error)
    } else if run.needsAttention {
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Palette.warning)
    } else {
      Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.success)
    }
  }

  private var statusWord: String {
    if run.isRunning { return "running" }
    if run.launchError != nil || run.exitStatus != 0 { return "failed" }
    return run.needsAttention ? "finished with failures" : "done"
  }

  @ViewBuilder private var when: some View {
    if run.isRunning {
      TimelineView(.periodic(from: run.startedAt, by: 1)) { context in
        Text(Format.elapsed(ms: context.date.timeIntervalSince(run.startedAt) * 1000)).monospacedDigit()
      }
    } else if let finishedAt = run.finishedAt {
      TimelineView(.periodic(from: finishedAt, by: 30)) { context in
        Text(Format.age(context.date.timeIntervalSince(finishedAt)))
      }
    }
  }
}
