import Foundation

/// The sidebar footer prioritizes the stim-daemon's pressure level and Desktop updates over optional agent CLI updates.
public enum SidebarFooterStatus: Equatable, Sendable {
  case pressureCritical(reasons: [String])
  case desktopUpdateAvailable
  case pressureHigh(reasons: [String])
  case stimUpdateAvailable(installed: SemanticVersion, latest: SemanticVersion)
  /// `nil` before `Onboarding.check()` reports, when the footer has no version to show yet.
  case normal(SemanticVersion?)

  public static func decide(
    stim: CLICompatibility?, pressure: DaemonStatus.Pressure?, desktopUpdateAvailable: Bool,
    stimUpdate: SemanticVersion? = nil
  ) -> SidebarFooterStatus {
    if let pressure, pressure.level == "critical" { return .pressureCritical(reasons: pressure.reasons) }
    if desktopUpdateAvailable { return .desktopUpdateAvailable }
    if let pressure, pressure.level == "high" { return .pressureHigh(reasons: pressure.reasons) }
    if case .compatible(let version) = stim {
      if let stimUpdate { return .stimUpdateAvailable(installed: version, latest: stimUpdate) }
      return .normal(version)
    }
    return .normal(nil)
  }
}

/// A device `stim status` reports as driven, and the workspace it belongs to, for the sidebar
/// footer's agent indicator.
public struct DrivenDevice: Equatable, Sendable {
  public var workspaceTitle: String
  public var deviceLabel: String

  public init(workspaceTitle: String, deviceLabel: String) {
    self.workspaceTitle = workspaceTitle
    self.deviceLabel = deviceLabel
  }

  /// Every device across `environments` whose activity state is `driven` (agent-device, a lock, or
  /// another driver holds it).
  public static func all(in environments: [Workspace]) -> [DrivenDevice] {
    environments.flatMap { env in
      env.devices.filter { $0.activity?.state == "driven" }
        .map { DrivenDevice(workspaceTitle: env.names.title, deviceLabel: $0.label(among: env.devices)) }
    }
  }
}
