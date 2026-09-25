import StimKit
import SwiftUI

struct OnboardingBanner: View {
  @ObservedObject var onboarding: Onboarding
  @EnvironmentObject private var actions: ActionCenter
  @AppStorage(AppPreferences.Key.servesPhones) private var servesPhones = false

  var body: some View {
    VStack(spacing: 10) {
      if let report = onboarding.report {
        if !report.stim.isCompatible {
          stimCard(report)
        } else if report.needsRelaunch {
          relaunchCard(report)
        }
        if let server = report.server, !server.isCompatible {
          serverCard(server, path: report.serverPath)
        }
        if report.stim.isCompatible, !report.needsRelaunch, !report.viewerKeys.isEmpty {
          viewerCard(report.viewerKeys)
        }
      }
    }
    .padding(.horizontal, 20)
    .padding(.top, onboarding.report.map(\.isEmpty) == false ? 12 : 0)
    .onChange(of: servesPhones) { onboarding.check() }
  }

  private func stimCard(_ report: Onboarding.Report) -> some View {
    let missing = report.stim == .missing
    let minimum = StimCLI.minimumVersion.description
    return card(icon: missing ? "shippingbox" : "arrow.up.circle", tint: Theme.lavender) {
      Text(missing ? "Install stim to get started" : "Update stim to use Stim Desktop").font(Theme.heading(15))
      Text(
        "Stim gives each React Native or Expo workspace its own Metro port and its own simulator or emulator, caches native builds, and keeps structured logs. Stim Desktop shows and drives what the stim command-line tool manages, so it needs stim \(minimum) or later."
      )
      .foregroundStyle(Theme.secondary)
      Text(detail(report.stim, name: "stim", path: report.stimPath))
        .font(Theme.body(11.5)).foregroundStyle(Theme.tertiary)
    } buttons: {
      runButton(missing ? "Install stim" : "Update stim", action: onboarding.installStim)
      Button("Choose stim executable\u{2026}", action: onboarding.chooseStim).buttonStyle(.stim())
    }
  }

  private func relaunchCard(_ report: Onboarding.Report) -> some View {
    card(icon: "arrow.clockwise", tint: Theme.lavender) {
      Text("Restart Stim Desktop to use the new stim").font(Theme.heading(15))
      Text("Stim Desktop resolves stim once at launch. It now finds \(abbreviatingHome(report.stimPath ?? "stim")).")
        .foregroundStyle(Theme.secondary)
    } buttons: {
      if onboarding.canRelaunch {
        Button("Restart Stim Desktop", action: onboarding.relaunch).buttonStyle(.stim(.primary))
      }
    }
  }

  private func serverCard(_ server: CLICompatibility, path: String?) -> some View {
    let missing = server == .missing
    return card(icon: "iphone.gen3.radiowaves.left.and.right", tint: Theme.warn) {
      Text(missing ? "Install stim-server to serve phones" : "Update stim-server to serve phones")
        .font(Theme.heading(15))
      Text(
        "Serving phones is on. stim-server shares Stim's status with the phones you pair over Tailscale, and Stim Desktop needs version \(StimServerCLI.minimumVersion.description) or later."
      )
      .foregroundStyle(Theme.secondary)
      Text(detail(server, name: "stim-server", path: path)).font(Theme.body(11.5)).foregroundStyle(Theme.tertiary)
    } buttons: {
      runButton(missing ? "Install stim-server" : "Update stim-server", action: onboarding.installServer)
      Button("Choose stim-server executable\u{2026}", action: onboarding.chooseServer).buttonStyle(.stim())
    }
  }

  private func viewerCard(_ keys: [String]) -> some View {
    card(icon: "macwindow", tint: Theme.lavender) {
      Text("Show Stim's devices in Stim Desktop").font(Theme.heading(15))
      Text("Stim can open the simulators and emulators it boots here instead of in their own windows.")
        .foregroundStyle(Theme.secondary)
      ForEach(keys, id: \.self) { key in
        VStack(alignment: .leading, spacing: 2) {
          Text("stim settings set \(key) stim-desktop --scope machine").font(Theme.mono())
          Text(Self.viewerExplanation[key] ?? "").font(Theme.body(11.5)).foregroundStyle(Theme.secondary)
        }
      }
      Text(
        keys.count == 1
          ? "It is a machine setting; change it back any time in Settings > Machine."
          : "Both are machine settings; change them back any time in Settings > Machine.")
        .font(Theme.body(11.5)).foregroundStyle(Theme.tertiary)
    } buttons: {
      runButton("Use Stim Desktop", variant: .primary, action: onboarding.useDesktopViewer)
      Button("Not now", action: onboarding.dismissViewerOffer).buttonStyle(.stim())
    }
  }

  private static let viewerExplanation = [
    "iosSimulatorApp":
      "iOS: an owned simulator opens here, focused on its workspace, instead of in Xcode's Simulator app.",
    "androidEmulatorApp":
      "Android: Stim boots owned emulators without a window and shows them here. One already running keeps its window until it next boots.",
  ]

  private func detail(_ compatibility: CLICompatibility, name: String, path: String?) -> String {
    switch compatibility {
    case .missing:
      return "No \(name) on the login shell's PATH. Installing runs npm install --global and needs Node.js 22.12 or later."
    case .outdated(let found?):
      return "\(abbreviatingHome(path ?? name)) reports \(found)."
    case .outdated(nil):
      return "\(abbreviatingHome(path ?? name)) did not report a version."
    case .compatible(let version):
      return "\(abbreviatingHome(path ?? name)) \(version)"
    }
  }

  @ViewBuilder
  private func runButton(
    _ title: String, variant: StimButtonVariant = .secondary, action: @escaping () -> Void
  ) -> some View {
    if let active = actions.active(for: Onboarding.actionKey) {
      Button {
        actions.presented = active
      } label: {
        HStack(spacing: 6) {
          ProgressView().controlSize(.small)
          Text("Running")
        }
      }
      .buttonStyle(.stim(variant))
    } else {
      Button(title, action: action).buttonStyle(.stim(variant))
    }
  }

  private func card<Body: View, Buttons: View>(
    icon: String, tint: Color, @ViewBuilder text: () -> Body, @ViewBuilder buttons: () -> Buttons
  ) -> some View {
    Card {
      HStack(alignment: .top, spacing: 14) {
        Image(systemName: icon).font(.system(size: 20)).foregroundStyle(tint).frame(width: 24)
        VStack(alignment: .leading, spacing: 6) {
          text()
          HStack(spacing: 8) { buttons() }.padding(.top, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .padding(16)
    }
  }
}

extension Onboarding.Report {
  var isEmpty: Bool {
    stim.isCompatible && !needsRelaunch && (server?.isCompatible ?? true) && viewerKeys.isEmpty
  }
}
