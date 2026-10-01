import Lottie
import StimKit
import SwiftUI

/// The artwork at the top of each setup guide screen: the Stim jar for the welcome and the summary, and small
/// vector scenes in the brand colors for the others. Every motion stops under Reduce Motion.
struct SetupIllustration: View {
  var step: SetupStep
  var complete = false
  var stimVersion: String?

  var body: some View {
    Group {
      switch step {
      case .welcome: JarArt(showsCheck: false)
      case .done: JarArt(showsCheck: complete)
      case .cli: TerminalArt(version: stimVersion)
      case .skill: SkillArt()
      case .notifications: NotificationArt()
      case .check: DoctorArt()
      }
    }
    .frame(height: 150)
    .frame(maxWidth: .infinity)
    .accessibilityHidden(true)
  }
}

private struct BrandHalo: View {
  var size: CGFloat = 150
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var turning = false

  var body: some View {
    ZStack {
      Circle()
        .fill(
          RadialGradient(
            colors: [Palette.brand.opacity(0.22), Palette.brand.opacity(0)], center: .center,
            startRadius: 0, endRadius: size / 2))
      Circle()
        .strokeBorder(
          AngularGradient(
            colors: [Palette.accent.opacity(0.5), Palette.accent.opacity(0), Palette.accent.opacity(0.5)],
            center: .center),
          style: StrokeStyle(lineWidth: 1.5, dash: [3, 6])
        )
        .padding(size * 0.08)
        .rotationEffect(.degrees(turning ? 360 : 0))
    }
    .frame(width: size, height: size)
    .onAppear {
      guard !reduceMotion else { return }
      withAnimation(.linear(duration: 24).repeatForever(autoreverses: false)) { turning = true }
    }
  }
}

private struct BrandBadge: View {
  var systemImage: String
  var size: CGFloat = 76

  var body: some View {
    RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
      .fill(LinearGradient(colors: [Palette.brand, Palette.accent], startPoint: .topLeading, endPoint: .bottomTrailing))
      .frame(width: size, height: size)
      .shadow(color: Palette.brand.opacity(0.35), radius: 12, y: 6)
      .overlay {
        Image(systemName: systemImage)
          .font(.system(size: size * 0.42, weight: .semibold))
          .foregroundStyle(Palette.onBrand)
      }
  }
}

private struct JarArt: View {
  var showsCheck: Bool
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ZStack {
      BrandHalo(size: 150)
      if let jar = BrandAssets.jar(colorScheme) {
        LottieView(animation: .filepath(jar.path))
          .playbackMode(
            reduceMotion ? .paused(at: .frame(0)) : .playing(.fromProgress(0, toProgress: 1, loopMode: .loop))
          )
          .resizable()
          .frame(width: 84, height: 136)
          .id(jar)
      }
      if showsCheck {
        Image(systemName: "checkmark.circle.fill")
          .font(.system(size: 30, weight: .semibold))
          .foregroundStyle(Palette.onBrand, Palette.success)
          .offset(x: 40, y: 44)
          .transition(reduceMotion ? .opacity : .scale(scale: 0.2).combined(with: .opacity))
      }
    }
    .animation(reduceMotion ? nil : .spring(response: 0.4, dampingFraction: 0.55), value: showsCheck)
  }
}

private struct TerminalArt: View {
  var version: String?
  private var lines: [String] {
    ["$ npm install --global stim", "added 1 package", "$ stim --version", version ?? "1.0.0"]
  }
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var typed = 0
  @State private var cursorOn = true

  private var total: Int { lines.reduce(0) { $0 + $1.count } }

  var body: some View {
    ZStack {
      BrandHalo(size: 150)
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 5) {
          ForEach([Color(rgba: 0xFF5F57FF), Color(rgba: 0xFEBC2EFF), Color(rgba: 0x28C840FF)], id: \.self) {
            Circle().fill($0).frame(width: 7, height: 7)
          }
        }
        .padding(.bottom, Space.md)
        ForEach(Array(visibleLines.enumerated()), id: \.offset) { index, line in
          HStack(spacing: 0) {
            Text(line)
              .foregroundStyle(line.hasPrefix("$") ? Media.text : Media.textTertiary)
            if index == visibleLines.count - 1 {
              Rectangle().fill(Palette.accent).frame(width: 6, height: 11).opacity(cursorOn ? 1 : 0)
            }
          }
          .font(.stim(.caption, mono: true))
          .lineLimit(1)
          .frame(height: 16)
        }
        Spacer(minLength: 0)
      }
      .padding(Space.lg)
      .frame(width: 236, height: 112, alignment: .topLeading)
      .background(RoundedRectangle(cornerRadius: Radius.card).fill(Media.screen))
      .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.accent.opacity(0.4)))
      .shadow(color: Palette.brand.opacity(0.3), radius: 16, y: 8)
    }
    .task {
      guard !reduceMotion else {
        typed = total
        return
      }
      while !Task.isCancelled {
        for count in 0...total {
          typed = count
          cursorOn = true
          try? await Task.sleep(for: .milliseconds(lines[0].count > count ? 55 : 30))
        }
        for _ in 0..<6 {
          try? await Task.sleep(for: .milliseconds(450))
          cursorOn.toggle()
        }
      }
    }
  }

  private var visibleLines: [String] {
    var left = typed
    var out: [String] = []
    for line in lines {
      guard left > 0 || out.isEmpty else { break }
      out.append(String(line.prefix(left)))
      left -= min(left, line.count)
    }
    return out
  }
}

private struct SkillArt: View {
  private static let agents = ["Claude Code", "Codex", "Cursor"]
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var floating = false

  var body: some View {
    ZStack {
      BrandHalo(size: 150)
      BrandBadge(systemImage: "sparkles")
        .symbolEffect(.pulse, isActive: !reduceMotion)
      ForEach(Array(Self.agents.enumerated()), id: \.offset) { index, name in
        Text(name)
          .font(.stim(.caption, weight: .semibold))
          .foregroundStyle(Palette.primary)
          .padding(.horizontal, Space.md)
          .padding(.vertical, Space.xs)
          .background(Capsule().fill(Palette.surface))
          .overlay(Capsule().strokeBorder(Palette.border))
          .shadow(color: Palette.shadow.opacity(0.08), radius: 4, y: 2)
          .offset(chipOffset(index))
          .offset(y: floating ? (index.isMultiple(of: 2) ? -4 : 4) : 0)
      }
    }
    .onAppear {
      guard !reduceMotion else { return }
      withAnimation(.easeInOut(duration: 2.2).repeatForever(autoreverses: true)) { floating = true }
    }
  }

  private func chipOffset(_ index: Int) -> CGSize {
    [CGSize(width: -104, height: -34), CGSize(width: 100, height: -12), CGSize(width: -80, height: 54)][index]
  }
}

private struct NotificationArt: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var ringing = false
  @State private var bannerIn = false

  var body: some View {
    ZStack {
      BrandHalo(size: 150)
      BrandBadge(systemImage: "bell.badge.fill")
        .rotationEffect(.degrees(ringing ? 6 : -6), anchor: .top)
        .offset(y: -18)
      HStack(spacing: Space.md) {
        Image(systemName: OversightCategory.stuck.symbol)
          .foregroundStyle(Palette.onBrand)
          .frame(width: 22, height: 22)
          .background(RoundedRectangle(cornerRadius: 6).fill(Palette.brand))
        VStack(alignment: .leading, spacing: 0) {
          Text(OversightCategory.stuck.label).font(.stim(.caption, weight: .semibold))
          Text("No progress for \(Oversight.defaultStuckMinutes) minutes").font(.stim(.caption2)).foregroundStyle(
            Palette.secondary)
        }
      }
      .padding(.horizontal, Space.lg)
      .padding(.vertical, Space.md)
      .background(RoundedRectangle(cornerRadius: Radius.control).fill(.regularMaterial))
      .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Palette.border))
      .shadow(color: Palette.shadow.opacity(0.12), radius: 8, y: 4)
      .offset(x: bannerIn ? 40 : 180, y: 52)
      .opacity(bannerIn ? 1 : 0)
    }
    .onAppear {
      guard !reduceMotion else {
        bannerIn = true
        return
      }
      withAnimation(.easeInOut(duration: 0.5).repeatForever(autoreverses: true)) { ringing = true }
      withAnimation(.spring(response: 0.6, dampingFraction: 0.75).delay(0.4)) { bannerIn = true }
    }
  }
}

private struct DoctorArt: View {
  private static let checks = ["Xcode", "Android SDK", "JDK"]
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var passed = 0

  var body: some View {
    ZStack {
      BrandHalo(size: 150)
      HStack(spacing: Space.xl) {
        BrandBadge(systemImage: "stethoscope", size: 64)
        VStack(alignment: .leading, spacing: Space.sm) {
          ForEach(Array(Self.checks.enumerated()), id: \.offset) { index, name in
            HStack(spacing: Space.sm) {
              Image(systemName: index < passed ? "checkmark.circle.fill" : "circle.dotted")
                .foregroundStyle(index < passed ? Palette.success : Palette.tertiary)
                .contentTransition(.symbolEffect(.replace))
              Text(name).font(.stim(.callout)).foregroundStyle(Palette.text)
            }
          }
        }
        .padding(Space.lg)
        .background(RoundedRectangle(cornerRadius: Radius.card).fill(Palette.surface))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.border))
      }
    }
    .task {
      guard !reduceMotion else {
        passed = Self.checks.count
        return
      }
      while !Task.isCancelled {
        passed = 0
        for count in 1...Self.checks.count {
          try? await Task.sleep(for: .milliseconds(700))
          withAnimation(.easeOut(duration: 0.2)) { passed = count }
        }
        try? await Task.sleep(for: .seconds(2.5))
      }
    }
  }
}
