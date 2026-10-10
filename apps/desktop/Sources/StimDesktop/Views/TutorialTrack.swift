import Lottie
import StimKit
import SwiftUI

struct TutorialTrack: View {
  var steps: [TutorialStep]
  var progress: [TutorialStepProgress]
  @State private var seenDone: Set<String>?
  @State private var celebrating: Set<String> = []
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    HStack(spacing: 0) {
      ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
        let state = progress.first { $0.id == step.id }?.state ?? .pending
        node(step, state: state)
        if index < steps.count - 1 {
          segment(filled: state == .done || state == .skipped)
        }
      }
    }
    .frame(height: 22)
    .onChange(of: doneIDs, initial: true) { _, done in celebrate(done) }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Tutorial progress")
    .accessibilityValue("\(doneIDs.count) of \(steps.count) steps done")
  }

  private var doneIDs: Set<String> { Set(progress.filter { $0.state == .done }.map(\.id)) }

  private func celebrate(_ done: Set<String>) {
    defer { seenDone = done }
    guard let seenDone, !reduceMotion else { return }
    celebrating.formUnion(done.subtracting(seenDone))
  }

  private func node(_ step: TutorialStep, state: TutorialStepState) -> some View {
    let size: CGFloat = step.optional ? 12 : 16
    return ZStack {
      switch state {
      case .done:
        Circle().fill(Palette.success)
        Image(systemName: "checkmark").font(.system(size: size * 0.55, weight: .bold)).foregroundStyle(Palette.onBrand)
      case .current:
        Circle().strokeBorder(Palette.primary, lineWidth: 2)
        Circle().fill(Palette.primary).frame(width: size * 0.4, height: size * 0.4)
      case .failed:
        Circle().strokeBorder(Palette.error, lineWidth: 2)
        Image(systemName: "exclamationmark").font(.system(size: size * 0.55, weight: .bold))
          .foregroundStyle(Palette.error)
      case .skipped:
        Circle().strokeBorder(Palette.tertiary, lineWidth: 1.5)
        Image(systemName: "minus").font(.system(size: size * 0.5, weight: .bold)).foregroundStyle(Palette.tertiary)
      case .pending:
        Circle().strokeBorder(
          Palette.tertiary, style: StrokeStyle(lineWidth: 1.5, dash: step.optional ? [2, 2] : []))
      }
    }
    .frame(width: size, height: size)
    .overlay {
      if celebrating.contains(step.id), let url = BrandAssets.stepDone(colorScheme) {
        LottieView(animation: .filepath(url.path))
          .playbackMode(.playing(.fromProgress(0, toProgress: 1, loopMode: .playOnce)))
          .animationDidFinish { _ in celebrating.remove(step.id) }
          .resizable()
          .frame(width: 40, height: 40)
          .allowsHitTesting(false)
      }
    }
    .help(step.title)
  }

  private func segment(filled: Bool) -> some View {
    Rectangle()
      .fill(filled ? Palette.success : Palette.tertiary.opacity(0.5))
      .frame(height: filled ? 2 : 1)
      .frame(maxWidth: .infinity)
  }
}
