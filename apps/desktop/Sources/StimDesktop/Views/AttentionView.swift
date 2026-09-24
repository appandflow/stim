import AppKit
import StimKit
import SwiftUI

struct AttentionView: View {
  @ObservedObject var store: StatusStore

  var body: some View {
    let envs = store.payload?.environments ?? []
    let warnings = envs.flatMap { env in env.warnings.map { (env: env, text: $0) } }
    let unwarmed = store.payload?.unprovisionedWorktrees ?? []
    ScrollView {
      VStack(alignment: .leading, spacing: 28) {
        VStack(alignment: .leading, spacing: 4) {
          Text("Needs attention").font(Theme.heading(22))
          Text("Copy a command and run it, or hand it to an agent.").foregroundStyle(Theme.secondary)
        }
        group("Warnings", count: warnings.count) {
          ForEach(Array(warnings.enumerated()), id: \.offset) { index, item in
            if index > 0 { divider }
            row(
              title: item.text,
              detail: "\(item.env.names.title) \u{00B7} \(store.project(of: item.env).name)",
              command: remedyCommand(forWarning: item.text, workspace: item.env.path))
          }
        }
        group("Worktrees not warmed", count: unwarmed.count) {
          ForEach(Array(unwarmed.enumerated()), id: \.offset) { index, worktree in
            if index > 0 { divider }
            row(
              title: PathNames(path: worktree.path).title,
              detail: worktree.branch ?? worktree.path,
              command: warmCommand(worktree: worktree.path))
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

  private func row(title: String, detail: String, command: String?) -> some View {
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
          NSPasteboard.general.setString(command, forType: .string)
        }
        .help(command)
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
