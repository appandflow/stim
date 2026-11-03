import Foundation
import Testing

@testable import StimKit

private let compatible = CLICompatibility.compatible(SemanticVersion("1.11.0")!)
private let outdated = CLICompatibility.outdated(found: "1.9.0")
private let critical = DaemonStatus.Pressure(level: "critical", disk: "critical", reasons: ["4 GB free on /"])
private let warning = DaemonStatus.Pressure(level: "high", disk: "high", reasons: ["12 GB free on /"])

@Suite struct SidebarFooterStatusTests {
  @Test func optionalCLIDoesNotHideMachineProblems() {
    #expect(
      SidebarFooterStatus.decide(stim: outdated, pressure: critical, desktopUpdateAvailable: true)
        == .pressureCritical(reasons: critical.reasons))
    #expect(
      SidebarFooterStatus.decide(stim: .missing, pressure: nil, desktopUpdateAvailable: false)
        == .normal(nil))
  }

  @Test func criticalDiskOutranksADesktopUpdate() {
    #expect(
      SidebarFooterStatus.decide(stim: compatible, pressure: critical, desktopUpdateAvailable: true)
        == .pressureCritical(reasons: critical.reasons))
  }

  @Test func desktopUpdateOutranksAWarningLevelDisk() {
    #expect(
      SidebarFooterStatus.decide(stim: compatible, pressure: warning, desktopUpdateAvailable: true)
        == .desktopUpdateAvailable)
  }

  @Test func warningLevelDiskShowsWhenNothingHigherApplies() {
    #expect(
      SidebarFooterStatus.decide(stim: compatible, pressure: warning, desktopUpdateAvailable: false)
        == .pressureHigh(reasons: warning.reasons))
  }

  @Test func aNewerStimShowsBelowEveryOtherNotice() {
    let newer = SemanticVersion("1.14.0")!
    #expect(
      SidebarFooterStatus.decide(stim: compatible, pressure: nil, desktopUpdateAvailable: false, stimUpdate: newer)
        == .stimUpdateAvailable(installed: SemanticVersion("1.11.0")!, latest: newer))
    #expect(
      SidebarFooterStatus.decide(stim: compatible, pressure: nil, desktopUpdateAvailable: true, stimUpdate: newer)
        == .desktopUpdateAvailable)
    #expect(
      SidebarFooterStatus.decide(stim: compatible, pressure: warning, desktopUpdateAvailable: false, stimUpdate: newer)
        == .pressureHigh(reasons: warning.reasons))
    #expect(
      SidebarFooterStatus.decide(stim: outdated, pressure: nil, desktopUpdateAvailable: false, stimUpdate: newer)
        == .normal(nil))
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

  @Test func emptyWhenNoWorkspaceHasADrivenDevice() {
    var undriven = workspace
    undriven.slots = nil
    #expect(DrivenDevice.all(in: [undriven]) == [])
  }
}
