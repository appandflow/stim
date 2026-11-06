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
        version.map { "Optional agent CLI stim \($0) is installed" } ?? "Stim Desktop uses the Stim engine"
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

  private func serverProblemButton(_ problem: String) -> some View {
    IconButton(
      systemImage: "exclamationmark.triangle", tint: Palette.warning,
      help:
        "stim-server is unavailable, so replay, the diff viewer and archived logs are too: \(abbreviatingHome(problem)) \u{2014} click to retry",
      label: "stim-server unavailable", action: server.retry)
  }

  private var settingsButton: some View {
    IconButton(systemImage: "gearshape", help: "Settings (\u{2318},)", label: "Settings") { openSettings() }
  }
}
