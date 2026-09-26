import Foundation
import Testing

@testable import StimKit

private let compatible = CLICompatibility.compatible(SemanticVersion("1.11.0")!)
private let outdated = CLICompatibility.outdated(found: "1.9.0")
private let critical = PressurePlan(
  freeBytes: 2_000_000_000, minimumFreeGb: 20, belowHardFloor: true, clearsWorkspaces: 0, removesWorktrees: 0,
  deletesDevices: 0, reclaimableBytes: 0)
private let warning = PressurePlan(
  freeBytes: 12_000_000_000, minimumFreeGb: 20, belowHardFloor: false, clearsWorkspaces: 0, removesWorktrees: 0,
  deletesDevices: 0, reclaimableBytes: 0)

@Suite struct SidebarFooterStatusTests {
  @Test func stimUnavailableOutranksEverythingElse() {
    #expect(
      SidebarFooterStatus.decide(stim: outdated, pressure: critical, desktopUpdateAvailable: true)
        == .stimUnavailable(outdated))
    #expect(
      SidebarFooterStatus.decide(stim: .missing, pressure: nil, desktopUpdateAvailable: false)
        == .stimUnavailable(.missing))
  }

  @Test func criticalDiskOutranksADesktopUpdate() {
    #expect(
      SidebarFooterStatus.decide(stim: compatible, pressure: critical, desktopUpdateAvailable: true)
        == .diskCritical(freeBytes: critical.freeBytes))
  }

  @Test func desktopUpdateOutranksAWarningLevelDisk() {
    #expect(
      SidebarFooterStatus.decide(stim: compatible, pressure: warning, desktopUpdateAvailable: true)
        == .desktopUpdateAvailable)
  }

  @Test func warningLevelDiskShowsWhenNothingHigherApplies() {
    #expect(
      SidebarFooterStatus.decide(stim: compatible, pressure: warning, desktopUpdateAvailable: false)
        == .diskWarning(freeBytes: warning.freeBytes))
  }

  @Test func normalShowsTheCheckedCLIVersion() {
    #expect(
      SidebarFooterStatus.decide(stim: compatible, pressure: nil, desktopUpdateAvailable: false)
        == .normal(SemanticVersion("1.11.0")!))
  }

  @Test func normalWithNoVersionBeforeTheLaunchCheckReports() {
    #expect(SidebarFooterStatus.decide(stim: nil, pressure: nil, desktopUpdateAvailable: false) == .normal(nil))
  }
}

@Suite struct DrivenDeviceTests {
  let workspace: Workspace = {
    let url = Bundle.module.url(forResource: "status", withExtension: "json", subdirectory: "Fixtures")!
    let payload = try! JSONDecoder().decode(StatusPayload.self, from: Data(contentsOf: url))
    return payload.environments[0]
  }()

  @Test func findsOnlyTheDrivenDeviceAcrossWorkspaces() {
    let driven = DrivenDevice.all(in: [workspace])
    #expect(driven == [DrivenDevice(workspaceTitle: "wide-insets", deviceLabel: "ipad")])
  }

  @Test func ignoresIdleAndRemoteDevices() {
    let driven = DrivenDevice.all(in: [workspace])
    #expect(!driven.contains { $0.deviceLabel == "Android emulator" })
    #expect(!driven.contains { $0.deviceLabel == "EAS iOS" })
  }

  @Test func emptyWhenNoWorkspaceHasADrivenDevice() {
    var undriven = workspace
    undriven.slots = nil
    #expect(DrivenDevice.all(in: [undriven]) == [])
  }
}
