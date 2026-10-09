import SwiftUI

struct PhoneAppsArt: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var floating = false

  var body: some View {
    ZStack {
      BrandHalo(size: 150).id(reduceMotion)
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .fill(Palette.surface)
        .frame(width: 68, height: 120)
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Palette.brand, lineWidth: 3))
        .overlay(alignment: .top) {
          Capsule().fill(Palette.brand).frame(width: 24, height: 5).padding(.top, Space.sm)
        }
      VStack(spacing: Space.sm) {
        ForEach([PhoneInstallApp.stim, .tailscale], id: \.self) { app in
          app.logo.frame(width: 24, height: 24).frame(width: 34, height: 34)
            .background(.white, in: RoundedRectangle(cornerRadius: Radius.small))
            .overlay(RoundedRectangle(cornerRadius: Radius.small).strokeBorder(Palette.border))
        }
      }.padding(.top, Space.sm)
      Label("App Store", systemImage: "arrow.down.app").font(.stim(.caption, weight: .semibold)).foregroundStyle(Palette.primary)
        .padding(.horizontal, Space.md).padding(.vertical, Space.xs)
        .background(Capsule().fill(Palette.surface)).overlay(Capsule().strokeBorder(Palette.border))
        .shadow(color: Palette.shadow.opacity(0.08), radius: 4, y: 2)
        .offset(x: 70, y: floating ? -34 : -30)
    }
    .frame(height: 150).frame(maxWidth: .infinity).accessibilityHidden(true)
    .task(id: reduceMotion) {
      withAnimation(reduceMotion ? nil : .easeInOut(duration: 2.2).repeatForever(autoreverses: true)) {
        floating = !reduceMotion
      }
    }
  }
}

struct PhoneTailnetArt: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ZStack {
      BrandHalo(size: 150).id(reduceMotion)
      Path {
        $0.move(to: CGPoint(x: 56, y: 75))
        $0.addLine(to: CGPoint(x: 164, y: 75))
      }
      .stroke(Palette.brand.opacity(0.5), style: StrokeStyle(lineWidth: 2, dash: [3, 5]))
      TimelineView(.animation(paused: reduceMotion)) { context in
        let progress = reduceMotion ? 0.5 : context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 3) / 3
        Circle().fill(Palette.accent).frame(width: 8, height: 8).offset(x: -54 + 108 * progress)
      }
      HStack(spacing: 108) {
        BrandBadge(systemImage: "laptopcomputer", size: 56)
        BrandBadge(systemImage: "iphone", size: 56)
      }
    }
    .frame(width: 220, height: 150).frame(maxWidth: .infinity).accessibilityHidden(true)
  }
}

struct PhoneServeArt: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ZStack {
      BrandHalo(size: 150).id(reduceMotion)
      BrandBadge(systemImage: "antenna.radiowaves.left.and.right")
        .symbolEffect(.pulse, isActive: !reduceMotion)
      HStack(spacing: Space.xs) {
        Image(systemName: "lock.fill").font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.brand)
        Text("Tailnet only").font(.stim(.caption, weight: .semibold)).foregroundStyle(Palette.primary)
      }
      .padding(.horizontal, Space.md).padding(.vertical, Space.xs)
      .background(Capsule().fill(Palette.surface)).overlay(Capsule().strokeBorder(Palette.border))
      .shadow(color: Palette.shadow.opacity(0.08), radius: 4, y: 2).offset(x: 62, y: 46)
    }
    .frame(height: 150).frame(maxWidth: .infinity).accessibilityHidden(true)
  }
}

struct PhonePairedArt: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var showsCheck = false

  var body: some View {
    ZStack {
      BrandHalo(size: 150).id(reduceMotion)
      BrandBadge(systemImage: "iphone")
      if showsCheck {
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
