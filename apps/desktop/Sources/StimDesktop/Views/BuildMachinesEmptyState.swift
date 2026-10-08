import SwiftUI

/// The artwork for "no remote Macs": a Mac badge with the two things a remote Mac does for this Mac.
struct BuildMachineArt: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var floating = false

  var body: some View {
    ZStack {
      BrandHalo(size: 150)
      BrandBadge(systemImage: "desktopcomputer")
      chip("Builds", systemImage: "hammer.fill").offset(x: -104, y: -30).offset(y: floating ? -4 : 0)
      chip("Simulators", systemImage: "iphone.gen3").offset(x: 98, y: 40).offset(y: floating ? 4 : 0)
    }
    .frame(height: 150)
    .accessibilityHidden(true)
    .onAppear {
      guard !reduceMotion else { return }
      withAnimation(.easeInOut(duration: 2.2).repeatForever(autoreverses: true)) { floating = true }
    }
  }

  private func chip(_ title: String, systemImage: String) -> some View {
    HStack(spacing: Space.xs) {
      Image(systemName: systemImage).font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.brand)
      Text(title).font(.stim(.caption, weight: .semibold)).foregroundStyle(Palette.primary)
    }
    .padding(.horizontal, Space.md)
    .padding(.vertical, Space.xs)
    .background(Capsule().fill(Palette.surface))
    .overlay(Capsule().strokeBorder(Palette.border))
    .shadow(color: Palette.shadow.opacity(0.08), radius: 4, y: 2)
  }
}

/// What the Remote Macs tab and the Machine page show while `remote.machines` is empty.
struct BuildMachinesEmptyState: View {
  var add: () -> Void
  var addDisabled = false
  var needsTailscale = false
  var tailscaleOff = false
  var checking = false

  var body: some View {
    VStack(spacing: Space.lg) {
      if checking {
        ProgressView().controlSize(.regular).frame(height: 150)
        Text("Checking Tailscale\u{2026}").foregroundStyle(Palette.secondary)
      } else {
        if tailscaleOff {
          AddMachineIllustration(scene: .tailscaleOff)
        } else {
          BuildMachineArt()
        }
        Text(tailscaleOff ? "Tailscale is off" : "No remote Macs").font(.stim(.headline))
        Text(
          tailscaleOff
            ? "Turn on Tailscale on this Mac. Remote Macs reach it over your tailnet, and they show up here once it is connected."
            : needsTailscale
              ? "Remote Macs need Tailscale on both Macs, signed in to the same tailnet. No other Mac is on this tailnet yet. It shows up here once both are connected."
              : "A remote Mac is another Mac on your tailnet that compiles your apps and hosts simulators for this Mac."
        )
        .foregroundStyle(Palette.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 380)
      }
      if checking || !needsTailscale || tailscaleOff {
        Button("Add Remote Mac\u{2026}", action: add)
          .buttonStyle(.stim(.primary, .regular))
          .disabled(addDisabled)
      }
    }
    .padding(Space.huge)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
