import Foundation
import Testing

@testable import StimKit

@Suite struct MachineDetailTests {
  private func status(_ json: String) throws -> BuildMachineStatus {
    try JSONDecoder().decode(BuildMachineStatus.self, from: Data(json.utf8))
  }

  private func findings(_ json: String) throws -> [DoctorReport.Finding] {
    try JSONDecoder().decode([DoctorReport.Finding].self, from: Data(json.utf8))
  }

  private let sdk = "/sdk/cmdline-tools/latest/bin/sdkmanager"

  @Test func aNoteNeverSetsThePillAndABlockingProblemDoes() throws {
    let noted = try status(
      #"""
      {"machine":"mini-2","state":"approved","offloadable":true,"reasons":[],"problems":[],
       "notes":[{"code":"ndk","reason":"Android: NDK 27.1.12297006 is not installed there; Gradle downloads it on the first build (about 1-2 GB)"},
                {"code":"compile-sdk","reason":"Android: platform android-36 is not installed there; Gradle downloads it on the first build"}]}
      """#)
    #expect(noted.pill(install: nil, update: nil) == MachineListStatus(title: "Approved", tone: .success))
    #expect(noted.rowDetail == "Builds can run there.")

    let blocked = try status(
      #"""
      {"machine":"mini-2","state":"approved","offloadable":false,
       "problems":[{"code":"cocoapods","reason":"iOS: CocoaPods 1.17.0 there, 1.16.2 here"}],
       "notes":[{"code":"ndk","reason":"Android: NDK is not installed there; Gradle downloads it"}]}
      """#)
    #expect(blocked.pill(install: nil, update: nil) == MachineListStatus(title: "CocoaPods differs", tone: .warning))
  }

  @Test func theDetailGroupsProblemsAndNotesByPlatformWithTheirFixCommands() throws {
    let list = try status(
      #"""
      {"machine":"mini-2","state":"approved","offloadable":false,
       "problems":[{"code":"cocoapods","reason":"iOS: CocoaPods 1.17.0 there, 1.16.2 here"},
                   {"code":"stim-build","reason":"Stim build 5773060690f40277 there, d9b8bdb39828c9a0 here"}]}
      """#)
    let android = try status(
      #"""
      {"machine":"mini-2","state":"approved","offloadable":true,
       "notes":[{"code":"ndk","reason":"NDK 27.1.12297006 is not installed there; Gradle downloads it on the first build (about 1-2 GB)"}]}
      """#)
    let androidFindings = try findings(
      #"""
      [{"code":"build-machine-ndk","level":"note","title":"Remote machine mini-2 downloads this project's NDK on its first Android build",
        "detail":"The build goes there anyway: NDK 27.1.12297006 is not installed there; Gradle downloads it on the first build (about 1-2 GB).",
        "fix":"On mini-2, install the package now so the first build does not download it:\n/sdk/cmdline-tools/latest/bin/sdkmanager \"ndk;27.1.12297006\""}]
      """#)
    var input = MachineDetail.Input(entry: "mini-2", status: list)
    input.android = .loaded(android, androidFindings)
    let detail = MachineDetail(input)

    #expect(detail.groups.map(\.platform) == [.machine, .ios, .android])
    let ios = try #require(detail.groups.first { $0.platform == .ios }?.issues.first)
    #expect(ios.kind == .problem)
    #expect(ios.reason == "CocoaPods 1.17.0 there, 1.16.2 here")
    #expect(ios.fix?.commands == ["gem install cocoapods -v 1.16.2"])
    let machine = try #require(detail.groups.first { $0.platform == .machine }?.issues.first)
    #expect(machine.reason == "Stim build 5773060 there, d9b8bdb here")
    let note = try #require(detail.groups.first { $0.platform == .android }?.issues.first)
    #expect(note.kind == .note)
    #expect(note.fix?.commands == ["\(sdk) \"ndk;27.1.12297006\""])
    #expect(note.fix?.text == ["On mini-2, install the package now so the first build does not download it:"])
  }

  @Test func theAndroidReportReplacesTheListsAndroidIssuesAndAddsThoseTheListLacks() throws {
    let list = try status(
      #"""
      {"machine":"mini-2","state":"approved","offloadable":false,
       "problems":[{"code":"ndk","reason":"Android: no NDK 27.1.12297006 there"},
                   {"code":"compile-sdk","reason":"Android: no platform android-36 there"}]}
      """#)
    var input = MachineDetail.Input(entry: "mini-2", status: list)
    #expect(MachineDetail(input).groups.map(\.platform) == [.android])

    let android = try status(
      #"""
      {"machine":"mini-2","state":"approved","offloadable":false,
       "problems":[{"code":"jdk","reason":"JDK 25 there, 17 here"},{"code":"android-sdk","reason":"no Android SDK there"}]}
      """#)
    input.android = .loaded(android, [])
    let issues = try #require(MachineDetail(input).groups.first { $0.platform == .android }?.issues)
    #expect(issues.map(\.code) == ["jdk", "android-sdk"])
    #expect(issues.allSatisfy { $0.kind == .problem })
  }

  @Test func theUpdateThisMacPillDoesNotHideTheMachinesOtherProblems() throws {
    let list = try status(
      #"""
      {"machine":"mini","state":"approved","offloadable":false,
       "problems":[{"code":"stim-build","reason":"Stim build a there, b here"},
                   {"code":"runtime","reason":"iOS: no iOS 26.0 simulator runtime there"}]}
      """#)
    var input = MachineDetail.Input(entry: "mini", status: list)
    input.install = .blocked(StimInstallBlock(reason: "newer", action: .checkForUpdates))
    let detail = MachineDetail(input)
    #expect(detail.pill == MachineListStatus(title: "Update this Mac", tone: .warning))
    #expect(detail.groups.flatMap(\.issues).map(\.code) == ["stim-build", "runtime"])
    #expect(detail.groups.flatMap(\.issues).first?.fix == nil)
  }

  @Test func theAndroidReportsProgressAndFailureAreSaidOnThePage() throws {
    let list = try status(#"{"machine":"mini","state":"approved","offloadable":true}"#)
    var input = MachineDetail.Input(entry: "mini", status: list)
    input.android = .loading
    #expect(MachineDetail(input).androidMessage == "Checking the Android tools\u{2026}")
    input.android = .failed("Update the local stim-server to check platform tools.")
    #expect(
      MachineDetail(input).androidMessage
        == "Could not check the Android tools: Update the local stim-server to check platform tools.")
    input.android = .loaded(nil, [])
    #expect(MachineDetail(input).androidMessage == nil)
  }

  @Test func aStateThatStopsTheMachineShowsItsDiagnosisWithCopyableCommands() throws {
    let down = try status(
      #"""
      {"machine":"studio","state":"unreachable","diagnosis":{"layer":"server","code":"server-not-running","title":"Server not running",
        "message":"nothing listens behind the route (HTTP 502).",
        "remedy":"On studio, run `stim-server service status`; `stim-server service install --serve` starts it and keeps it running."}}
      """#)
    let detail = MachineDetail(MachineDetail.Input(entry: "studio", status: down))
    let situation = try #require(detail.situation)
    #expect(situation.title == "Server not running")
    #expect(situation.commands == ["stim-server service status", "stim-server service install --serve"])
    #expect(detail.groups.isEmpty)

    let pending = try status(#"{"machine":"studio","state":"pending"}"#)
    #expect(MachineDetail(MachineDetail.Input(entry: "studio", status: pending)).situation?.title == "Waiting for approval")
  }

  @Test func capacityVersionsAndApprovalsComeFromTheReports() throws {
    let list = try status(
      #"""
      {"machine":"mini","state":"approved","offloadable":false,
       "problems":[{"code":"stim-build","reason":"Stim build a there, b here"}],
       "capacity":{"running":0,"max":1,"builds":1,"maxBuilds":2,"cpus":10,"loadPerCore":0.5,"maxLoadPerCore":2,"diskFreeBytes":825196154880,
                   "memoryUsedBytes":9663676416,"memoryTotalBytes":17179869184}}
      """#)
    var input = MachineDetail.Input(entry: "mini", status: list)
    input.thisMacVersion = "1.25.0"
    input.serverVersion = "1.24.0"
    input.host = BuildMachineStatus(machine: "mini", state: .approved)
    let detail = MachineDetail(input)
    #expect(
      detail.capacity.map(\.label) == ["Load", "RAM", "Disk", "Cores", "Builds running", "Offloaded builds"])
    #expect(detail.capacity.first { $0.label == "Builds running" }?.value == "1/2 builds")
    #expect(
      detail.versions == [
        MachineDetailRow(label: "This Mac", value: "Stim 1.25.0"),
        MachineDetailRow(label: "mini", value: "stim-server 1.24.0"),
        MachineDetailRow(label: "Build compatibility", value: "Stim build a there, b here", tone: .warning),
      ])
    #expect(
      detail.approvals == [
        MachineDetailRow(label: "Builds", value: "Approved", tone: .success),
        MachineDetailRow(label: "Hosted simulators", value: "Approved", tone: .success),
      ])
    input.host = nil
    #expect(MachineDetail(input).approvals.last?.value == "Not requested")
    input.hostsKnown = false
    #expect(MachineDetail(input).approvals.map(\.label) == ["Builds"])
    input.hostsKnown = true
    input.hostsSimulators = false
    #expect(MachineDetail(input).approvals.map(\.label) == ["Builds"])

    let unreachable = try status(
      #"{"machine":"mini","state":"approved","offloadable":false,"problems":[{"code":"unreachable","reason":"timed out"}]}"#)
    #expect(
      !MachineDetail(MachineDetail.Input(entry: "mini", status: unreachable)).versions.contains {
        $0.label == "Build compatibility"
      })
  }

  @Test func aFindingTitledRemoteMacStillSuppliesTheFix() throws {
    let list = try status(
      #"{"machine":"mini","state":"approved","offloadable":false,"problems":[{"code":"jdk","reason":"Android: JDK 25 there, 17 here"}]}"#
    )
    var input = MachineDetail.Input(entry: "mini", status: list)
    input.findings = try findings(
      #"[{"code":"build-machine-jdk","level":"cost","title":"Remote Mac mini runs another JDK","detail":"Builds fall back to this Mac: Android: JDK 25 there, 17 here.","fix":"On mini, install JDK 17:\nbrew install --cask zulu@17"}]"#
    )
    let issue = try #require(MachineDetail(input).groups.first?.issues.first)
    #expect(issue.platform == .android)
    #expect(issue.reason == "JDK 25 there, 17 here")
    #expect(issue.fix?.commands == ["brew install --cask zulu@17"])
  }

  @Test func aFixSplitsIntoSentencesAndCommands() {
    let fix = MachineFix(
      parsing:
        "On mini, accept the SDK licenses so Gradle downloads the package, or install it:\n/sdk/cmdline-tools/latest/bin/sdkmanager --licenses\n'/my sdk/cmdline-tools/latest/bin/sdkmanager' \"build-tools;37.0.0\""
    )
    #expect(fix.text == ["On mini, accept the SDK licenses so Gradle downloads the package, or install it:"])
    #expect(
      fix.commands == [
        "/sdk/cmdline-tools/latest/bin/sdkmanager --licenses",
        "'/my sdk/cmdline-tools/latest/bin/sdkmanager' \"build-tools;37.0.0\"",
      ])
    let advice = MachineFix(parsing: "Check that stim-server runs on mini, then run `stim doctor` again.")
    #expect(advice.commands == ["stim doctor"])
  }
}
