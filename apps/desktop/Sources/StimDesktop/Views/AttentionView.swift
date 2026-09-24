import AppKit
import StimKit
import SwiftUI

struct AttentionView: View {
  @ObservedObject var store: StatusStore
  @EnvironmentObject private var actions: ActionCenter

  var body: some View {
    let envs = store.payload?.environments ?? []
    let warnings = envs.flatMap { env in env.warnings.map { (env: env, text: $0) } }
    let unwarmed = store.payload?.unprovisionedWorktrees ?? []
    ScrollView {
      VStack(alignment: .leading, spacing: 28) {
        VStack(alignment: .leading, spacing: 4) {
          Text("Needs attention").font(Theme.heading(22))
          Text("Run a fix here, or copy the command and hand it to an agent.").foregroundStyle(Theme.secondary)
        }
        cleanup
        group("Warnings", count: warnings.count) {
          ForEach(Array(warnings.enumerated()), id: \.offset) { index, item in
            if index > 0 { divider }
            row(
              title: item.text,
              detail: "\(item.env.names.title) \u{00B7} \(store.project(of: item.env).name)",
              command: remedyCommand(forWarning: item.text, workspace: item.env.path),
              runTitle: "Fix \(item.env.names.title)")
          }
        }
        group("Worktrees not warmed", count: unwarmed.count) {
          ForEach(Array(unwarmed.enumerated()), id: \.offset) { index, worktree in
            if index > 0 { divider }
            row(
              title: PathNames(path: worktree.path).title,
              detail: worktree.branch ?? worktree.path,
              command: warmCommand(worktree: worktree.path),
              runTitle: "Warm \(PathNames(path: worktree.path).title)")
          }
        }
      }
      .padding(28)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var divider: some View {
    Rectangle().fill(Theme.border).frame(height: 1)
  }

  private var cleanup: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Machine cleanup").font(Theme.heading(15))
      Card {
        HStack(spacing: 14) {
          Image(systemName: "trash").foregroundStyle(Theme.lavender)
          VStack(alignment: .leading, spacing: 3) {
            Text("Reclaim what Stim left behind")
            Text("Preview the stim gc report, then confirm before anything is deleted.")
              .font(Theme.body(11.5)).foregroundStyle(Theme.secondary)
          }
          Spacer()
          runButton(
            "Preview cleanup", StimCommand(["gc", "--json"], cwd: NSHomeDirectory()), key: ActionCenter.machineKey)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
      }
    }
  }

  @ViewBuilder
  private func runButton(_ title: String, _ command: StimCommand, key: String? = nil, runTitle: String? = nil) -> some View {
    if let active = actions.active(for: key ?? command.cwd) {
      Button {
        actions.presented = active
      } label: {
        HStack(spacing: 6) {
          ProgressView().controlSize(.small)
          Text("Running")
        }
      }
    } else {
      Button(title) { actions.run(runTitle ?? title, command, key: key) }
        .help(command.shellLine)
    }
  }

  private func row(title: String, detail: String, command: StimCommand?, runTitle: String) -> some View {
    HStack(spacing: 14) {
      Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.warn)
      VStack(alignment: .leading, spacing: 3) {
        Text(title).lineLimit(2)
        Text(detail).font(Theme.body(11.5)).foregroundStyle(Theme.secondary)
      }
      Spacer()
      if let command {
        Button("Copy command") {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(command.shellLine, forType: .string)
        }
        .help(command.shellLine)
        runButton("Run stim \(command.arguments.joined(separator: " "))", command, runTitle: runTitle)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
  }

  private func group<Content: View>(_ title: String, count: Int, @ViewBuilder _ content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Text(title).font(Theme.heading(15))
        Text("\(count)").foregroundStyle(Theme.tertiary)
      }
      if count == 0 {
        Text("Nothing here.").foregroundStyle(Theme.tertiary)
      } else {
        Card { VStack(spacing: 0) { content() } }
      }
    }
  }
}
