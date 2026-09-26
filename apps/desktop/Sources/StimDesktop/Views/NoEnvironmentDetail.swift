import AppKit
import StimKit
import SwiftUI

struct NoEnvironmentDetail: View {
  var worktree: UnprovisionedWorktree

  var body: some View {
    let names = worktree.names
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 10) {
            Text(names.title).font(Theme.heading(22))
            Pill(tone: .neutral) { Text("no environment") }
          }
          Text(abbreviatingHome(worktree.path)).font(Theme.mono()).foregroundStyle(Palette.secondary).textSelection(.enabled)
          if let branch = worktree.branch {
            Label(branch, systemImage: "arrow.triangle.branch").foregroundStyle(Palette.secondary)
          }
        }
        VStack(alignment: .leading, spacing: 10) {
          SectionLabel(title: "Create an environment")
          Text("Stim has not registered this worktree yet. Any of these commands creates its environment.")
            .foregroundStyle(Palette.secondary)
          ForEach(environmentCommands(worktree: worktree.path), id: \.self) { command in
            HStack(spacing: 10) {
              CommandText(command: command.displayLine())
              Button("Copy") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(command.shellLine, forType: .string)
              }
            }
          }
        }
      }
      .padding(28)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}
