import AppKit
import StimKit
import SwiftUI

struct NoEnvironmentDetail: View {
  var worktree: UnprovisionedWorktree

  var body: some View {
    let names = worktree.names
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xxxl) {
        VStack(alignment: .leading, spacing: Space.sm) {
          HStack(spacing: Space.md) {
            Text(names.title).font(.stim(.title))
            Pill(tone: .neutral) { Text("no environment") }
          }
          Text(abbreviatingHome(worktree.path)).font(.stim(.caption, mono: true)).foregroundStyle(Palette.secondary).textSelection(.enabled)
          if let branch = worktree.branch {
            Label(branch, systemImage: "arrow.triangle.branch").foregroundStyle(Palette.secondary)
          }
        }
        VStack(alignment: .leading, spacing: Space.md) {
          SectionLabel(title: "Create an environment")
          Text("Stim has not registered this worktree yet. Any of these commands creates its environment.")
            .foregroundStyle(Palette.secondary)
          ForEach(environmentCommands(worktree: worktree.path), id: \.self) { command in
            HStack(spacing: Space.md) {
              CommandText(command: command.displayLine())
              Button("Copy") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(command.shellLine, forType: .string)
              }
            }
          }
        }
      }
      .padding(Space.xxxl)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}
