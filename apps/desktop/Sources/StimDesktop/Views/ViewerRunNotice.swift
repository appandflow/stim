import StimStores
import SwiftUI

struct ViewerRunNotice: View {
  @ObservedObject var run: ActionRun
  var openedAt: Date
  @State private var dismissedRunID: UUID?
  @EnvironmentObject private var actions: ActionCenter

  var body: some View {
    if run.isRunning || (run.needsAttention && (run.finishedAt.map { $0 > openedAt } ?? false) && dismissedRunID != run.id) {
      HStack(spacing: Space.md) {
        HStack(spacing: Space.md) {
          if run.isRunning {
            ProgressView().controlSize(.mini)
          } else {
            Image(systemName: "xmark.octagon.fill").foregroundStyle(Palette.error)
          }
          Text(run.isRunning ? run.title : "\(run.title) failed")
            .font(.stim(.footnote, weight: .medium))
            .foregroundStyle(run.isRunning ? Palette.text : Palette.error)
            .layoutPriority(1)
          if let line = run.statusLine {
            Text(line).foregroundStyle(Palette.secondary)
          }
          Spacer(minLength: 0)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(run.title) \(run.isRunning ? "running" : "failed")")
        .accessibilityValue(run.statusLine ?? "")
        if !run.isRunning {
          Button("Show output") { actions.presented = run }
            .nativeIconStyle(tint: Palette.primary)
            .fixedSize()
          Button("Dismiss", systemImage: "xmark") {
            dismissedRunID = run.id
            actions.operations.markSeen(run)
          }
          .labelStyle(.iconOnly)
          .nativeIconStyle()
          .accessibilityLabel("Dismiss failure")
        }
      }
      .font(.stim(.footnote))
      .lineLimit(1)
      .padding(.horizontal, Space.xl)
      .frame(height: 28)
      .background(Palette.surface)
      .overlay(alignment: .bottom) { Rectangle().fill(Palette.border).frame(height: 1) }
      .accessibilityElement(children: .contain)
    }
  }
}
