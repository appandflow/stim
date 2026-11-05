import SwiftUI

struct TutorialRestartDialogs: ViewModifier {
  @ObservedObject var tutorial: TutorialModel

  private var confirming: Binding<Bool> {
    Binding(
      get: { if case .confirm = tutorial.restartDialog { return true } else { return false } },
      set: { if !$0, case .confirm = tutorial.restartDialog { tutorial.restartDialog = nil } })
  }

  private var blocked: Binding<Bool> {
    Binding(
      get: { if case .blocked = tutorial.restartDialog { return true } else { return false } },
      set: { if !$0 { tutorial.restartDialog = nil } })
  }

  func body(content: Content) -> some View {
    content
      .confirmationDialog(
        "Restart the Tutorial?", isPresented: confirming, titleVisibility: .visible, presenting: tutorial.restartDialog
      ) { dialog in
        if case .confirm(let base, let worktrees) = dialog {
          Button("Delete & Restart", role: .destructive) { tutorial.confirmRestart(base: base, worktrees: worktrees) }
        }
        Button("Cancel", role: .cancel) {}
      } message: { dialog in
        if case .confirm(let base, let worktrees) = dialog {
          let names = worktrees.map { ($0 as NSString).abbreviatingWithTildeInPath }
          Text(
            "Restart deletes \((base as NSString).abbreviatingWithTildeInPath)"
              + (names.isEmpty ? "" : " and its worktrees \(names.joined(separator: ", "))")
              + ". The folder moves to the Trash.")
        }
      }
      .alert("Tutorial Not Restarted", isPresented: blocked) {
        Button("OK", role: .cancel) {}
      } message: {
        if case .blocked(let reason) = tutorial.restartDialog { Text(reason) }
      }
  }
}
