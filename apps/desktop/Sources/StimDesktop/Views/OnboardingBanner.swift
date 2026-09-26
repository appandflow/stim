import StimKit
import SwiftUI

/// A floating toast anchored to the bottom of the main content column: one problem at a time,
/// most important first, so it never resizes content or covers the toolbar or inspector.
struct OnboardingBanner: View {
  @ObservedObject var onboarding: Onboarding
  @EnvironmentObject private var actions: ActionCenter
  @AppStorage(AppPreferences.Key.servesPhones) private var servesPhones = false
  @State private var showsCommand = false

  var body: some View {
    Group {
      if let report = onboarding.report, let kind = currentKind(report) {
        popup(kind, report)
          .transition(.move(edge: .bottom).combined(with: .opacity))
      }
    }
    .frame(maxWidth: .infinity)
    .animation(.easeOut(duration: 0.2), value: onboarding.report.flatMap(currentKind))
    .onChange(of: servesPhones) { onboarding.check() }
  }

  private func currentKind(_ report: Onboarding.Report) -> Onboarding.PopupKind? {
    if !report.stim.isCompatible, !onboarding.dismissedPopups.contains(.stim) { return .stim }
    if report.needsRelaunch, !onboarding.dismissedPopups.contains(.relaunch) { return .relaunch }
    if let server = report.server, !server.isCompatible, !onboarding.dismissedPopups.contains(.server) {
      return .server
    }
    if report.stim.isCompatible, !report.needsRelaunch, !report.viewerKeys.isEmpty,
      !onboarding.dismissedPopups.contains(.viewer)
    {
      return .viewer
    }
    return nil
  }

  @ViewBuilder
  private func popup(_ kind: Onboarding.PopupKind, _ report: Onboarding.Report) -> some View {
    switch kind {
    case .stim: stimPopup(report)
    case .relaunch: relaunchPopup(report)
    case .server: serverPopup(report)
    case .viewer: viewerPopup(report.viewerKeys)
    }
  }

  private func stimPopup(_ report: Onboarding.Report) -> some View {
    let missing = report.stim == .missing
    let minimum = StimCLI.minimumVersion.description
    return popupCard(kind: .stim, icon: missing ? "shippingbox" : "arrow.up.circle", tone: .accent) {
      Text(missing ? "Install stim to get started" : "Update stim to use Stim Desktop").font(Theme.heading(14))
      Text("Stim Desktop needs stim \(minimum) or later to show and drive your workspaces.")
        .foregroundStyle(Palette.secondary)
      disclosure { Text(detail(report.stim, name: "stim", path: report.stimPath)) }
    } buttons: {
      runButton(missing ? "Install stim" : "Update stim", variant: .primary, key: .stim, action: onboarding.installStim)
      Button("Choose stim executable\u{2026}", action: onboarding.chooseStim).buttonStyle(.stim())
    }
  }

  private func relaunchPopup(_ report: Onboarding.Report) -> some View {
    popupCard(kind: .relaunch, icon: "arrow.clockwise", tone: .accent) {
      Text("Restart Stim Desktop to use the new stim").font(Theme.heading(14))
      Text("Stim Desktop resolves stim once at launch, and it now finds a different one.")
        .foregroundStyle(Palette.secondary)
      disclosure { Text(abbreviatingHome(report.stimPath ?? "stim")) }
    } buttons: {
      if onboarding.canRelaunch {
        Button("Restart Stim Desktop", action: onboarding.relaunch).buttonStyle(.stim(.primary))
      }
    }
  }

  private func serverPopup(_ report: Onboarding.Report) -> some View {
    guard let server = report.server else { return AnyView(EmptyView()) }
    let missing = server == .missing
    return AnyView(
      popupCard(kind: .server, icon: "iphone.gen3.radiowaves.left.and.right", tone: .warning) {
        Text(missing ? "Install stim-server to serve phones" : "Update stim-server to serve phones")
          .font(Theme.heading(14))
        Text("stim-server shares Stim's status with paired phones, and Stim Desktop needs \(StimServerCLI.minimumVersion.description) or later.")
          .foregroundStyle(Palette.secondary)
        disclosure { Text(detail(server, name: "stim-server", path: report.serverPath)) }
      } buttons: {
        runButton(
          missing ? "Install stim-server" : "Update stim-server", variant: .primary, key: .server,
          action: onboarding.installServer)
        Button("Choose stim-server executable\u{2026}", action: onboarding.chooseServer).buttonStyle(.stim())
      })
  }

  private func viewerPopup(_ keys: [String]) -> some View {
    popupCard(kind: .viewer, icon: "macwindow", tone: .accent) {
      Text("Show Stim's devices in Stim Desktop").font(Theme.heading(14))
      Text("Stim can open the simulators and emulators it boots here instead of in their own windows.")
        .foregroundStyle(Palette.secondary)
      disclosure {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(keys, id: \.self) { key in
            VStack(alignment: .leading, spacing: 2) {
              Text("stim settings set \(key) stim-desktop --scope machine").font(Theme.mono())
              Text(Self.viewerExplanation[key] ?? "").font(Theme.body(11)).foregroundStyle(Palette.secondary)
            }
          }
        }
      }
    } buttons: {
      runButton("Use Stim Desktop", variant: .primary, key: .viewer, action: onboarding.useDesktopViewer)
      Button("Not now") { onboarding.dismissPopup(.viewer) }.buttonStyle(.stim())
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
  private func disclosure<Content: View>(@ViewBuilder content: @escaping () -> Content) -> some View {
    DisclosureGroup("Show command", isExpanded: $showsCommand) {
      content().font(Theme.body(11.5)).foregroundStyle(Palette.tertiary).padding(.top, 4)
    }
    .font(Theme.body(11.5)).foregroundStyle(Palette.secondary)
  }

  @ViewBuilder
  private func runButton(
    _ title: String, variant: ButtonVariant = .secondary, key: Onboarding.PopupKind, action: @escaping () -> Void
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

  private func popupCard<Body: View, Buttons: View>(
    kind: Onboarding.PopupKind, icon: String, tone: BannerTone, @ViewBuilder text: () -> Body,
    @ViewBuilder buttons: () -> Buttons
  ) -> some View {
    Banner(tone: tone, icon: icon, style: .floating, onDismiss: { onboarding.dismissPopup(kind) }) {
      text()
      HStack(spacing: Space.md) { buttons() }.padding(.top, Space.xxs)
    }
    .frame(minWidth: 420, maxWidth: 520)
    .padding(.bottom, Space.xxl)
  }
}
