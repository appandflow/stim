import Foundation

/// The sidebar footer shows one status line at a time. Priority, highest first: `stim` missing or
/// outdated, critical low disk, a Desktop update, warning-level low disk, then normal.
public enum SidebarFooterStatus: Equatable, Sendable {
  case stimUnavailable(CLICompatibility)
  case diskCritical(freeBytes: Int64)
  case desktopUpdateAvailable
  case diskWarning(freeBytes: Int64)
  /// `nil` before `Onboarding.check()` reports, when the footer has no version to show yet.
  case normal(SemanticVersion?)

  public static func decide(
    stim: CLICompatibility?, pressure: PressurePlan?, desktopUpdateAvailable: Bool
  ) -> SidebarFooterStatus {
    if let stim, !stim.isCompatible { return .stimUnavailable(stim) }
    if let pressure, pressure.belowHardFloor { return .diskCritical(freeBytes: pressure.freeBytes) }
    if desktopUpdateAvailable { return .desktopUpdateAvailable }
    if let pressure { return .diskWarning(freeBytes: pressure.freeBytes) }
    if case .compatible(let version) = stim { return .normal(version) }
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
  /// another driver holds it), matching the criterion `Workspace.orderedDevices` ranks by.
  public static func all(in environments: [Workspace]) -> [DrivenDevice] {
    environments.flatMap { env in
      env.devices.filter { $0.activity?.state == "driven" }
        .map { DrivenDevice(workspaceTitle: env.names.title, deviceLabel: $0.label(among: env.devices)) }
    }
  }
}
