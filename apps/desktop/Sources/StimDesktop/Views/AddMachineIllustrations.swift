import StimKit
import SwiftUI

/// The artwork at the top of each Add a remote Mac step, in the first-run guide's style. Every motion stops under
/// Reduce Motion.
struct AddMachineIllustration: View {
  enum Scene: Equatable {
    case tailnet(connected: Bool)
    case noMac
    case tailscaleSwitch
    case tailscaleOff
    case tailscaleUp
    case capabilities(Set<SetupCapability>)
    case command
    case waiting
    case tools
    case ready
  }

  var scene: Scene

  var body: some View {
    Group {
      switch scene {
      case .tailnet(let connected): TailnetArt(connected: connected)
      case .noMac: TailnetArt(connected: false, badge: "questionmark.circle.fill")
      case .tailscaleSwitch: TailscaleSwitchArt()
      case .tailscaleOff: TailscaleSwitchArt(staysOff: true)
      case .tailscaleUp:
        ZStack {
          BrandHalo(size: 130)
          TerminalCard(
            lines: [
              TerminalLine(text: "$ tailscale up", kind: .command),
              TerminalLine(text: "Success.", kind: .output),
            ], mode: .scripted(loop: true), height: 88)
        }
      case .capabilities(let chosen): CapabilitiesArt(chosen: chosen)
      case .waiting: TailnetArt(connected: true)
      case .command: MachinesArt(badge: "terminal.fill")
      case .tools: ToolsArt()
      case .ready: MachinesArt(badge: "checkmark")
      }
    }
    .frame(height: 120)
    .frame(maxWidth: .infinity)
    .accessibilityHidden(true)
  }
}

private struct MacGlyph: View {
  var symbol: String
  var dimmed = false

  var body: some View {
    Image(systemName: symbol)
      .font(.system(size: 40, weight: .regular))
      .foregroundStyle(dimmed ? Palette.tertiary : Palette.primary)
      .frame(width: 64, height: 56)
      .background(RoundedRectangle(cornerRadius: Radius.card).fill(Palette.surface))
      .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.border))
      .shadow(color: Palette.shadow.opacity(0.08), radius: 6, y: 3)
  }
}

/// This Mac and the build Mac, joined over the tailnet; the link breaks when this Mac has no Tailscale.
private struct TailnetArt: View {
  var connected: Bool
  var badge = "xmark.circle.fill"
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ZStack {
      BrandHalo(size: 130)
      HStack(spacing: 0) {
        MacGlyph(symbol: "laptopcomputer")
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion || !connected)) { timeline in
          Canvas { context, size in
            let y = size.height / 2
            var line = Path()
            line.move(to: CGPoint(x: 0, y: y))
            line.addLine(to: CGPoint(x: size.width, y: y))
            context.stroke(
              line, with: .color(connected ? Palette.accent : Palette.tertiary.opacity(0.6)),
              style: StrokeStyle(lineWidth: 1.5, lineCap: .round, dash: [3, 5]))
            if connected {
              let phase =
                reduceMotion ? 0.5 : timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
              let dot = CGRect(x: phase * (size.width - 8), y: y - 4, width: 8, height: 8)
              context.fill(Path(ellipseIn: dot), with: .color(Palette.brand))
            }
          }
        }
        .frame(width: 84, height: 20)
        .overlay {
          if !connected {
            Image(systemName: badge)
              .font(.system(size: 18, weight: .semibold))
              .foregroundStyle(Palette.onBrand, Palette.tertiary)
              .background(Circle().fill(Palette.background).padding(2))
          }
        }
        MacGlyph(symbol: "macmini", dimmed: !connected)
      }
    }
  }
}

/// The Tailscale menu bar item's menu, with its switch turning on.
private struct TailscaleSwitchArt: View {
  var staysOff = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var on = false

  var body: some View {
    ZStack {
      BrandHalo(size: 130)
      VStack(spacing: 0) {
        HStack(spacing: Space.lg) {
          Spacer()
          Image(systemName: "wifi").foregroundStyle(Palette.tertiary)
          Image(systemName: "circle.grid.3x3.fill")
            .foregroundStyle(Palette.text)
            .padding(.horizontal, Space.xs)
            .background(RoundedRectangle(cornerRadius: Radius.small).fill(Palette.text.opacity(Opacity.pressed)))
          Text("9:41").font(.stim(.caption, weight: .semibold)).foregroundStyle(Palette.text)
        }
        .font(.system(size: 11))
        .padding(.horizontal, Space.md)
        .frame(height: 22)
        .background(Palette.raised)
        HStack(spacing: Space.md) {
          VStack(alignment: .leading, spacing: 0) {
            Text("Tailscale").font(.stim(.callout, weight: .semibold)).foregroundStyle(Palette.text)
            Text(on ? "Connected" : "Not Connected").font(.stim(.caption)).foregroundStyle(
              on ? Palette.success : Palette.secondary
            )
            .contentTransition(.opacity)
          }
          Spacer()
          Capsule()
            .fill(on ? Palette.brand : Palette.tertiary.opacity(Opacity.track))
            .frame(width: 34, height: 20)
            .overlay(alignment: on ? .trailing : .leading) {
              Circle().fill(Palette.onBrand).padding(2).shadow(color: Palette.shadow.opacity(0.2), radius: 1, y: 1)
            }
        }
        .padding(Space.md)
      }
      .frame(width: 200)
      .background(RoundedRectangle(cornerRadius: Radius.control).fill(Palette.surface))
      .clipShape(RoundedRectangle(cornerRadius: Radius.control))
      .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Palette.border))
      .shadow(color: Palette.shadow.opacity(0.12), radius: 8, y: 4)
    }
    .task {
      guard !staysOff else { return }
      guard !reduceMotion else {
        on = true
        return
      }
      while !Task.isCancelled {
        on = false
        try? await Task.sleep(for: .seconds(1.2))
        withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) { on = true }
        try? await Task.sleep(for: .seconds(2.4))
      }
    }
  }
}

/// The two capabilities as chips around the build badge; a chip dims when its capability is off.
private struct CapabilitiesArt: View {
  var chosen: Set<SetupCapability>
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var floating = false

  var body: some View {
    ZStack {
      BrandHalo(size: 130)
      BrandBadge(systemImage: "macmini.fill", size: 64)
        .opacity(chosen.isEmpty ? Opacity.disabled : 1)
        .animation(fade, value: chosen.isEmpty)
      chip("hammer.fill", "Builds", on: chosen.contains(.build))
        .offset(x: -104, y: floating ? -26 : -20)
      chip("iphone", "Hosted simulators", on: chosen.contains(.deviceHost))
        .offset(x: 112, y: floating ? 30 : 24)
    }
    .onAppear {
      guard !reduceMotion else { return }
      withAnimation(.easeInOut(duration: 2.2).repeatForever(autoreverses: true)) { floating = true }
    }
  }

  private var fade: Animation? { reduceMotion ? nil : .easeInOut(duration: 0.2) }

  private func chip(_ symbol: String, _ title: String, on: Bool) -> some View {
    Label(title, systemImage: symbol)
      .font(.stim(.caption, weight: .semibold))
      .foregroundStyle(Palette.primary)
      .fixedSize()
      .padding(.horizontal, Space.md)
      .padding(.vertical, Space.xs)
      .background(Capsule().fill(Palette.surface))
      .overlay(Capsule().strokeBorder(Palette.accent.opacity(0.5)))
      .shadow(color: Palette.shadow.opacity(0.08), radius: 4, y: 2)
      .opacity(on ? 1 : 0.45)
      .animation(fade, value: on)
  }
}

/// The build Mac with a badge: the Terminal while setup runs, a check once it is ready.
private struct MachinesArt: View {
  var badge: String

  var body: some View {
    ZStack {
      BrandHalo(size: 130)
      BrandBadge(systemImage: "macmini.fill", size: 72)
      Image(systemName: badge)
        .font(.system(size: 13, weight: .bold))
        .foregroundStyle(Palette.onBrand)
        .frame(width: 30, height: 30)
        .background(Circle().fill(badge == "checkmark" ? Palette.success : Palette.accent))
        .overlay(Circle().strokeBorder(Palette.background, lineWidth: 2))
        .offset(x: 34, y: 30)
    }
  }
}

private struct ToolsArt: View {
  private static let checks = ["Xcode", "CocoaPods", "Android SDK"]
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var passed = 0

  var body: some View {
    ZStack {
      BrandHalo(size: 130)
      HStack(spacing: Space.xl) {
        BrandBadge(systemImage: "wrench.and.screwdriver.fill", size: 56)
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
