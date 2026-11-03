import StimKit
import StimStores
import SwiftUI

struct SidebarFooter: View {
  @ObservedObject var store: StatusStore
  @ObservedObject var pressure: DaemonPressureMonitor
  @ObservedObject var onboarding: Onboarding
  let actions: ActionCenter
  @ObservedObject private var updater = AppUpdater.shared
  @ObservedObject private var server = ServerController.shared
  @Binding var selection: SidebarItem?
  @AppStorage(AppPreferences.Key.servesPhones) private var servesPhones = false
  @ObservedObject private var flags = FeatureFlagStore.shared
  @AppStorage("settingsTab") private var settingsTab = "app"
  @Environment(\.openSettings) private var openSettings

  private var status: SidebarFooterStatus {
    SidebarFooterStatus.decide(
      stim: onboarding.report?.stim, pressure: pressure.daemon?.pressure,
      desktopUpdateAvailable: updater.isAvailable && updater.updateAvailable, stimUpdate: onboarding.stimUpdate)
  }

  private var drivenDevices: [DrivenDevice] { DrivenDevice.all(in: store.payload?.environments ?? []) }

  var body: some View {
    HStack(spacing: Space.sm) {
      if StimHome.isDefault(store.stimHome) {
        leftStatus
      } else {
        VStack(alignment: .leading, spacing: 0) {
          leftStatus
          Text(abbreviatingHome(store.stimHome))
            .font(.stim(.caption, mono: true))
            .foregroundStyle(Palette.tertiary)
            .lineLimit(1)
            .truncationMode(.head)
            .help(store.stimHome)
        }
      }
      Spacer(minLength: 8)
      OperationsButton(log: actions.operations, actions: actions, store: store)
      if !drivenDevices.isEmpty { agentsButton }
      if let problem = server.problem { serverProblemButton(problem) }
      if PhoneApp.showsSidebarButton(phoneApp: flags.phoneApp, servesPhones: servesPhones) { phonesButton }
      settingsButton
    }
    .padding(.horizontal, Space.md)
    .frame(height: 44)
    .background(Palette.sidebar)
    .overlay(alignment: .top) { Rectangle().fill(Palette.border).frame(height: 1) }
  }

  @ViewBuilder private var leftStatus: some View {
    switch status {
    case .stimUpdateAvailable(let installed, let latest):
      Button(action: onboarding.installStim) {
        statusLabel(dot: Palette.primary, text: "stim \(latest.description) available")
      }
      .buttonStyle(.hoverRow(outset: Space.sm))
      .help(
        "stim \(installed.description) is installed \u{2014} click to update it with \(onboarding.report?.stimOwner?.rawValue ?? "its package manager")"
      )
    case .pressureCritical(let reasons):
      Button {
        selection = .machine
      } label: {
        statusLabel(dot: Palette.error, text: "Pressure critical")
      }
      .buttonStyle(.hoverRow(outset: Space.sm))
      .help((reasons + ["click to open Machine"]).joined(separator: " \u{2014} "))
    case .desktopUpdateAvailable:
      Button(action: updater.checkForUpdates) {
        statusLabel(dot: Palette.primary, text: "Update available")
      }
      .buttonStyle(.hoverRow(outset: Space.sm))
      .help("A new version of Stim Desktop is available \u{2014} click to install it")
    case .pressureHigh(let reasons):
      Button {
        selection = .machine
      } label: {
        statusLabel(dot: Palette.warning, text: "Pressure high")
      }
      .buttonStyle(.hoverRow(outset: Space.sm))
      .help((reasons + ["click to open Machine"]).joined(separator: " \u{2014} "))
    case .normal(let version):
      let help: String =
        version.map { "Optional agent CLI stim \($0) is installed" } ?? "Stim Desktop uses its bundled server"
      statusLabel(dot: Palette.success, text: version.map { "Stim \($0)" } ?? "Stim")
        .help(help)
    }
  }

  private func statusLabel(dot: Color, text: String) -> some View {
    HStack(spacing: Space.sm) {
      StatusDot(color: dot, size: 6)
      Text(text).font(.stim(.footnote)).foregroundStyle(Palette.secondary).lineLimit(1)
    }
  }

  private var agentsButton: some View {
    IconButton(
      systemImage: "cursorarrow.rays", tint: Palette.accent, badge: "\(drivenDevices.count)", help: agentsTooltip
    ) {
      selection = .wall
    }
  }

  private var agentsTooltip: String {
    let count = drivenDevices.count
    return
      (["\(count) device\(count == 1 ? "" : "s") driven by an agent or tool \u{2014} click to show Active workspaces"]
      + drivenDevices.map { "\($0.workspaceTitle) \u{2192} \($0.deviceLabel)" }).joined(separator: "\n")
  }

  private var phonesButton: some View {
    IconButton(systemImage: "iphone.gen3.radiowaves.left.and.right", help: phonesTooltip) {
      OpenRequests.shared.pairsPhone = true
      settingsTab = "phones"
      openSettings()
    }
  }

  private func serverProblemButton(_ problem: String) -> some View {
    IconButton(
      systemImage: "exclamationmark.triangle", tint: Palette.warning,
      help:
        "stim-server is unavailable, so replay, the diff viewer and archived logs are too: \(abbreviatingHome(problem)) \u{2014} click to retry",
      label: "stim-server unavailable", action: server.retry)
  }

  private var phonesTooltip: String {
    switch server.state {
    case .off: return "Phone server is off \u{2014} click to open Paired Devices settings"
    case .starting, .notReady(.pending, _): return "Phone server is starting \u{2014} click to open Paired Devices settings"
    case .notReady(.degraded(let reason), _):
      return "Phone server is degraded: \(abbreviatingHome(reason)) \u{2014} click to open Paired Devices settings"
    case .failed(let message): return "Phone server failed: \(message) \u{2014} click to open Paired Devices settings"
    case .running(let health, _):
      guard let route = health.route, let dnsName = health.tailscale.dnsName else {
        return "Phone server is running, but phones cannot reach it over Tailscale yet \u{2014} click to pair a phone"
      }
      return "Phone server is running at \(route.endpoint(dnsName: dnsName)) \u{2014} click to pair a phone"
    }
  }

  private var settingsButton: some View {
    IconButton(systemImage: "gearshape", help: "Settings (\u{2318},)", label: "Settings") { openSettings() }
  }
}
