import SwiftUI

private struct MiniWindow: View {
  var width: CGFloat
  var height: CGFloat

  var body: some View {
    RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
      .fill(Palette.surface)
      .frame(width: width, height: height)
      .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Palette.brand, lineWidth: 2))
      .overlay(alignment: .topLeading) {
        HStack(spacing: 3) {
          ForEach(0..<3) { _ in Circle().fill(Palette.brand.opacity(0.45)).frame(width: 5, height: 5) }
        }
        .padding(Space.sm)
      }
      .overlay(alignment: .bottomLeading) {
        VStack(alignment: .leading, spacing: 3) {
          Capsule().fill(Palette.brand.opacity(0.35)).frame(width: width * 0.6, height: 4)
          Capsule().fill(Palette.brand.opacity(0.2)).frame(width: width * 0.4, height: 4)
        }
        .padding(Space.md)
      }
  }
}

struct ViewerScreenArt: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ZStack {
      BrandHalo(size: 150).id(reduceMotion)
      Path {
        $0.move(to: CGPoint(x: 0, y: 0))
        $0.addLine(to: CGPoint(x: 44, y: 0))
      }
      .stroke(Palette.brand.opacity(0.5), style: StrokeStyle(lineWidth: 2, dash: [3, 5]))
      .frame(width: 44, height: 2)
      TimelineView(.animation(paused: reduceMotion)) { context in
        let progress = reduceMotion ? 0.5 : context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.4) / 2.4
        Circle().fill(Palette.accent).frame(width: 8, height: 8).offset(x: -22 + 44 * progress)
      }
      HStack(spacing: 44) {
        MiniWindow(width: 62, height: 48)
        RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
          .fill(Palette.sidebar)
          .frame(width: 96, height: 84)
          .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Palette.border))
          .overlay { MiniWindow(width: 72, height: 56) }
      }
    }
    .frame(height: 150).frame(maxWidth: .infinity).accessibilityHidden(true)
  }
}

struct ViewerControlArt: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ZStack {
      BrandHalo(size: 150).id(reduceMotion)
      MiniWindow(width: 124, height: 92)
      TimelineView(.animation(paused: reduceMotion)) { context in
        let phase = reduceMotion ? 0.5 : context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.8) / 1.8
        Circle().strokeBorder(Palette.accent, lineWidth: 2)
          .frame(width: 10 + 30 * phase, height: 10 + 30 * phase)
          .opacity(1 - phase)
      }
      .offset(x: 14, y: 6)
      Image(systemName: "cursorarrow").font(.system(size: 26, weight: .semibold))
        .foregroundStyle(Palette.onBrand, Palette.brand).symbolRenderingMode(.palette)
        .shadow(color: Palette.shadow.opacity(0.2), radius: 3, y: 2)
        .offset(x: 22, y: 16)
    }
    .frame(height: 150).frame(maxWidth: .infinity).accessibilityHidden(true)
  }
}

struct ViewerReadyArt: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var complete: Bool
  @State private var showsCheck = false

  var body: some View {
    ZStack {
      BrandHalo(size: 150).id(reduceMotion)
      BrandBadge(systemImage: "macwindow")
      if showsCheck && complete {
        Image(systemName: "checkmark.circle.fill").font(.system(size: 30, weight: .semibold))
          .foregroundStyle(Palette.onBrand, Palette.success).offset(x: 36, y: 36)
          .transition(reduceMotion ? .identity : .scale(scale: 0.2).combined(with: .opacity))
      }
    }
    .frame(height: 150).frame(maxWidth: .infinity).accessibilityHidden(true)
    .task(id: reduceMotion) {
      withAnimation(reduceMotion ? nil : .spring(response: 0.4, dampingFraction: 0.55)) { showsCheck = true }
    }
  }
}
