import XCTest

@testable import StimKit

final class SetupWizardTests: XCTestCase {
  private let now = Date(timeIntervalSince1970: 1_791_284_400)
  private var ticket: SetupTicket { SetupTicket.generate(now: now, randomBytes: { $0 = Array(0..<32) }) }
  private var mac: TailnetMac { TailnetMac(id: "nMini", hostName: "Mini", dnsName: "mini.tail.test") }

  private func wizard(
    settings: SetupWizard.Settings = .init(), capabilities: Set<SetupCapability> = [.build, .deviceHost], workspace: Bool = true
  ) -> SetupWizard {
    var wizard = SetupWizard(settings: settings, hasWorkspace: workspace)
    _ = wizard.apply(.macChosen(mac), now: now)
    _ = wizard.apply(.capabilitiesChanged(capabilities), now: now)
    _ = wizard.apply(.next(ticket), now: now)
    return wizard
  }
  private func journal(steps: [SetupJournal.Step] = [], grants: [SetupJournal.Grant] = [], done: Bool = false) -> SetupJournal {
    SetupJournal(nodeId: "nSelf", ticket: ticket, capabilities: [.build, .deviceHost], steps: steps, granted: grants, done: done)
  }
  private func status(_ state: BuildMachineStatus.State, id: String? = nil) -> BuildMachineStatus {
    BuildMachineStatus(machine: "mini", state: state, deviceId: id)
  }

  func testTicketIsUnpaddedURLSafeAndExpiresThirtyMinutesAfterGeneration() {
    XCTAssertNotNil(ticket.value.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression))
    XCTAssertEqual(ticket.value, "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
    XCTAssertEqual(ticket.hash, "ea866a757e4c38babfa8127cbe9a409d3e1f93a00ff1488ff735fcf917afffd0")
    XCTAssertEqual(ticket.expiresAt.timeIntervalSince(now), 1800)
    XCTAssertEqual(ticket.isoExpires, ISO8601DateFormatter().string(from: now.addingTimeInterval(1800)))
  }

  func testPreviewAndCommandFollowChosenCapabilitiesAndExistingApprovals() {
    let known = SetupKnown(serverVersion: "1.16.0", clientName: "Laptop")
    let builds = previewLines(capabilities: [.build], known: known)
    XCTAssertTrue(builds.contains { $0.text == "approved Laptop for builds" })
    XCTAssertFalse(builds.contains { $0.text.contains("permission") || $0.text.contains("hosted simulators") })
    let hosts = previewLines(capabilities: [.deviceHost], known: known)
    XCTAssertFalse(hosts.contains { $0.text.contains("for builds") })
    XCTAssertTrue(hosts.contains { $0.text == "Screen recording permission" })
    XCTAssertTrue(hosts.contains { $0.text == "Device control permission" })
    for build in [false, true] {
      for host in [false, true] {
        let known = SetupKnown(
          serverVersion: "1.16.0", buildApproved: build, hostApproved: host,
          screenRecordingGranted: true, deviceControlGranted: false, clientName: "Laptop")
        let preview = previewLines(capabilities: [.build, .deviceHost], known: known)
        XCTAssertTrue(preview.contains { $0.text == "approved Laptop for builds" + (build ? " (already done)" : "") })
        XCTAssertTrue(preview.contains { $0.text == "approved Laptop for hosted simulators" + (host ? " (already done)" : "") })
        XCTAssertTrue(preview.contains { $0.text == "Screen recording permission (already done)" })
        XCTAssertTrue(preview.contains { $0.text == "Device control permission" })
        let command = setupCommand(
          version: "1.16.0", client: "nSelf", ticket: ticket, capabilities: [.build, .deviceHost], known: known)
        XCTAssertEqual(command.contains("--build"), !build)
        XCTAssertEqual(command.contains("--device-host"), !host)
        XCTAssertTrue(command.hasPrefix("npx --yes --package @stim-cli/server@1.16.0 stim-server setup"))
        XCTAssertFalse(command.contains("setup --yes"))
        XCTAssertTrue(command.contains("--client nSelf"))
      }
    }
  }

  func testJournalDecodingPreservesOrderDetailsAndFixesAndHidesOnlySummary() throws {
    let data = Data(
      """
      {"v":1,"client":{"nodeId":"nSelf"},"expiresAt":"2026-10-06T14:05:00Z",
      "capabilities":["build","device-host"],"steps":[
      {"id":"preflight","state":"ok","title":"Node verified"},
      {"id":"server","state":"failed","title":"Server","detail":"predates setup support","fix":"npm install --global @stim-cli/server"},
      {"id":"approve","state":"running","title":"Answer y/N"},
      {"id":"permissions.screenRecording","state":"skipped","title":"Screen recording"},
      {"id":"future","state":"new-state","title":"Future check"},
      {"id":"summary","state":"ok","title":"All ready"},
      {"id":"journal","state":"pending","title":"Journal"}],
      "granted":[{"capability":"build","id":"req-1"}],"done":true,"exit":3}
      """.utf8)
    let journal = try JSONDecoder().decode(SetupJournal.self, from: data)
    XCTAssertEqual(journal.client.nodeId, "nSelf")
    XCTAssertEqual(journal.granted, [.init(capability: .build, id: "req-1")])
    XCTAssertEqual(journal.exit, 3)
    XCTAssertEqual(
      journalLines(journal, clientName: "Laptop"),
      [
        .init(text: "$ stim-server setup", kind: .command), .init(text: "tailnet node verified", kind: .ok),
        .init(text: "stim-server failed", kind: .failed),
        .init(text: "waiting for approval in Terminal", kind: .pending),
        .init(text: "Screen recording permission skipped", kind: .skipped),
        .init(text: "Future check", kind: .pending), .init(text: "setup journal not written", kind: .pending),
      ])
  }

  func testMirrorUsesThePreviewWordingWithoutIdsOrToolDetails() {
    let steps: [SetupJournal.Step] = [
      .init(id: "server", state: .ok, title: "stim-server 1.16.0", detail: "Installed exact release."),
      .init(id: "route", state: .ok, title: "Tailnet route", detail: "mini.tail.test: https port 7447"),
      .init(id: "approve", state: .ok, title: "Access approval", detail: "Chosen capabilities approved."),
      .init(
        id: "approve.build", state: .ok, title: "Approved Laptop (nomLHT1H9811CNTRL) for builds",
        detail: "request 5369b0fc"),
      .init(
        id: "approve.device-host", state: .ok, title: "Already approved Laptop (nomLHT1H9811CNTRL) for hosted simulators",
        detail: "request f975dee7"),
      .init(id: "tools", state: .ok, title: "Tools", detail: "Checked; installs nothing."),
      .init(id: "tools.Android SDK", state: .ok, title: "Android SDK", detail: #"{"ndk":["26.1.10909125"]}"#),
      .init(id: "tools.JDK", state: .pending, title: "JDK", detail: "Missing JDK", fix: "brew install --cask zulu@17"),
    ]
    let lines = journalLines(journal(steps: steps), clientName: "Laptop").dropFirst()
    XCTAssertEqual(
      Array(lines),
      [
        .init(text: "stim-server 1.16.0 installed", kind: .ok),
        .init(text: "tailnet route https 7447 (no Funnel)", kind: .ok),
        .init(text: "approved Laptop for builds", kind: .ok),
        .init(text: "approved Laptop for hosted simulators (already done)", kind: .ok),
        .init(text: "Android SDK", kind: .ok), .init(text: "JDK missing", kind: .pending),
      ])
  }

  func testPortProbeFindsJournalAndKeepsPollingNotReadyOrMissingRoutes() {
    let journal = journal()
    XCTAssertEqual(
      SetupPortProbe.resolve([7443: .unreachable, 7444: .notReady, 7447: .journal(journal)]), .found(port: 7447, journal: journal)
    )
    XCTAssertEqual(SetupPortProbe.resolve([7443: .notFound, 7444: .notReady]), .serverNotReady)
    XCTAssertEqual(SetupPortProbe.resolve(Dictionary(uniqueKeysWithValues: (7443...7452).map { ($0, .notFound) })), .notYet)
    XCTAssertEqual(SetupPortProbe.resolve([7443: .unreachable, 7444: .notFound]), .notYet)
    XCTAssertEqual(SetupPortProbe.entry(machine: "mini", port: 7443), "mini")
    XCTAssertEqual(SetupPortProbe.entry(machine: "mini", port: 7447), "mini:7447")
    XCTAssertEqual(SetupPortProbe.manualPort("65535"), 65535)
    XCTAssertNil(SetupPortProbe.manualPort("0"))
    XCTAssertNil(SetupPortProbe.manualPort("65536"))
  }

  func testFirstAnswerWritesEntriesOnceAndModeIsChangedOnlyForUnsetFirstBuildMachine() {
    for (settings, capabilities, expected) in [
      (SetupWizard.Settings(), Set([SetupCapability.build]), true),
      (.init(mode: "auto", modeOrigin: "default"), [.build], true),
      (.init(builds: ["other"]), [.build], false),
      (.init(mode: "auto", modeOrigin: "machine"), [.build], false),
      (.init(mode: "off", modeOrigin: "env"), [.build], false),
      (.init(), [.deviceHost], false),
    ] {
      var wizard = wizard(settings: settings, capabilities: capabilities)
      XCTAssertEqual(wizard.apply(.journalAnswered(port: 7447, journal: journal()), now: now), [.writeEntries(port: 7447)])
      XCTAssertEqual(wizard.modeChanged, expected)
      XCTAssertEqual(wizard.apply(.journalAnswered(port: 7447, journal: journal()), now: now), [])
      XCTAssertEqual(wizard.apply(.entriesWritten, now: now), [.askDoctor(ticket: ticket.value)])
    }
    var blocked = wizard(workspace: false)
    XCTAssertEqual(blocked.apply(.journalAnswered(port: 7443, journal: journal()), now: now), [])
    XCTAssertEqual(blocked.failure(now: now), .noWorkspace)
  }

  func testApprovalRequiresEveryChosenCapabilityAndMatchingGrantIds() {
    var wizard = wizard()
    _ = wizard.apply(
      .journalAnswered(
        port: 7443, journal: journal(grants: [.init(capability: .build, id: "b"), .init(capability: .deviceHost, id: "h")])),
      now: now)
    _ = wizard.apply(.doctorReported(build: status(.approved, id: "b"), host: status(.pending, id: "h")), now: now)
    XCTAssertEqual(wizard.phase, .running)
    _ = wizard.apply(.doctorReported(build: status(.approved, id: "b"), host: status(.approved, id: "different")), now: now)
    XCTAssertEqual(wizard.failure(now: now), .grantedOther(capability: .deviceHost, journalId: "h", doctorId: "different"))
    XCTAssertEqual(wizard.phase, .running)
    _ = wizard.apply(.doctorReported(build: status(.approved, id: "b"), host: status(.approved, id: "h")), now: now)
    XCTAssertEqual(wizard.phase, .approved)
    XCTAssertNil(wizard.failure(now: now))
  }

  func testAlreadyApprovedCapabilityCanBeOmittedFromSetupWithoutLosingVerifiedApproval() {
    var wizard = SetupWizard()
    _ = wizard.apply(.macChosen(mac), now: now)
    _ = wizard.apply(.doctorReported(build: status(.approved, id: "old-build"), host: status(.pending, id: "h")), now: now)
    _ = wizard.apply(.next(ticket), now: now)
    _ = wizard.apply(.journalAnswered(port: 7443, journal: journal(grants: [.init(capability: .deviceHost, id: "h")])), now: now)
    _ = wizard.apply(.doctorReported(build: status(.approved, id: "old-build"), host: status(.approved, id: "h")), now: now)
    XCTAssertEqual(wizard.phase, .approved)
  }

  func testLapsedRequestIsAskedAgainAtMostEveryThirtySecondsAndNeverAfterExpiry() {
    var wizard = wizard()
    _ = wizard.apply(.journalAnswered(port: 7443, journal: journal()), now: now)
    _ = wizard.apply(.entriesWritten, now: now)
    XCTAssertEqual(wizard.apply(.doctorReported(build: status(.revoked), host: nil), now: now.addingTimeInterval(29)), [])
    XCTAssertEqual(wizard.failure(now: now), .requestLapsed)
    XCTAssertEqual(wizard.apply(.tick, now: now.addingTimeInterval(30)), [.askDoctor(ticket: ticket.value)])
    XCTAssertEqual(wizard.apply(.tick, now: now.addingTimeInterval(59)), [])
    XCTAssertEqual(wizard.apply(.tick, now: now.addingTimeInterval(60)), [.askDoctor(ticket: ticket.value)])
    XCTAssertEqual(wizard.apply(.tick, now: ticket.expiresAt), [])
    XCTAssertEqual(wizard.failure(now: ticket.expiresAt), .expired)
    XCTAssertEqual(wizard.phase, .expiredCommand)
  }

  func testNoAnswerStartsAtThreeMinutesAndManualPortAcceptsOutsideProbeRange() {
    var wizard = wizard()
    XCTAssertNil(wizard.failure(now: now.addingTimeInterval(179)))
    XCTAssertEqual(wizard.failure(now: now.addingTimeInterval(180)), .noAnswer)
    _ = wizard.apply(.manualPort(9000), now: now)
    XCTAssertEqual(wizard.port, 9000)
    _ = wizard.apply(.manualPort(65536), now: now)
    XCTAssertEqual(wizard.port, 9000)
  }

  func testJournalFailuresPreserveExactFixAndNameUnsupportedPermissionFeature() {
    for (step, expected) in [
      (
        SetupJournal.Step(id: "server", state: .failed, title: "Old", detail: "1.15 predates setup support", fix: "update exact"),
        SetupWizard.Failure.serverTooOld(fix: "update exact")
      ),
      (
        .init(id: "route", state: .failed, title: "Public", fix: "tailscale funnel --https=7443 off"),
        .funneled(fix: "tailscale funnel --https=7443 off")
      ),
      (
        .init(id: "service", state: .failed, title: "Service", detail: "refused", fix: "exact fix"),
        .stepFailed(step: "Service", detail: "refused", fix: "exact fix")
      ),
      (
        .init(id: "permissions.screenRecording", state: .skipped, title: "Recording"),
        .permissionSkipped(feature: "Hosted simulators cannot be viewed")
      ),
      (
        .init(id: "permissions.deviceControl", state: .pending, title: "Control"),
        .permissionSkipped(feature: "Hosted simulators cannot be controlled")
      ),
    ] {
      var wizard = wizard()
      _ = wizard.apply(.journalAnswered(port: 7443, journal: journal(steps: [step], done: true)), now: now)
      XCTAssertEqual(wizard.failure(now: now), expected)
    }
    var expiring = wizard()
    _ = expiring.apply(.journalAnswered(port: 7443, journal: journal()), now: now)
    XCTAssertEqual(expiring.failure(now: ticket.expiresAt), .expired)
  }

  func testCancelRestoresOnlyWizardChangesForgetsPairingAndRetainsAllRevokeIds() {
    var wizard = wizard()
    XCTAssertEqual(wizard.apply(.cancel, now: now), [])
    wizard = SetupWizard()
    _ = wizard.apply(.macChosen(mac), now: now)
    _ = wizard.apply(.doctorReported(build: nil, host: nil), now: now)
    _ = wizard.apply(.next(ticket), now: now)
    _ = wizard.apply(
      .journalAnswered(port: 7443, journal: journal(grants: [.init(capability: .build, id: "journal-id")])), now: now)
    _ = wizard.apply(.entriesWritten, now: now)
    _ = wizard.apply(.doctorReported(build: status(.approved, id: "doctor-id"), host: nil), now: now)
    XCTAssertEqual(wizard.apply(.cancel, now: now), [.restoreSettings, .forgetPairing])
    XCTAssertEqual(wizard.revokeIds, ["journal-id", "doctor-id"])
    XCTAssertEqual(wizard.phase, .cancelled)
  }

  func testCancelDoesNotListApprovalsThatExistedBeforeTheWizard() {
    var wizard = SetupWizard(settings: .init(), hasWorkspace: true)
    _ = wizard.apply(.macChosen(mac), now: now)
    _ = wizard.apply(.doctorReported(build: status(.approved, id: "old-build"), host: nil), now: now)
    _ = wizard.apply(.next(ticket), now: now)
    _ = wizard.apply(.doctorReported(build: status(.approved, id: "old-build"), host: status(.pending, id: "new-host")), now: now)
    XCTAssertEqual(wizard.revokeIds, ["new-host"])
  }

  func testUnknownPreStateOnlyListsJournalGrantsForUndo() {
    var wizard = wizard(workspace: false)
    _ = wizard.apply(
      .doctorReported(build: status(.approved, id: "old-build"), host: status(.approved, id: "old-host")), now: now)
    XCTAssertTrue(wizard.revokeIds.isEmpty, "Undo must not revoke pre-existing approvals when their pre-state was unknown")
    _ = wizard.apply(
      .journalAnswered(
        port: 7443,
        journal: journal(grants: [.init(capability: .build, id: "new-build"), .init(capability: .deviceHost, id: "new-host")])),
      now: now)
    _ = wizard.apply(.cancel, now: now)
    XCTAssertEqual(wizard.revokeIds, ["new-build", "new-host"], "Undo must retain only the grants created by this run")
  }

  func testMirrorKeepsSkippedPermissionsWhileDoctorDecidesTheFailure() {
    var wizard = wizard()
    let steps: [SetupJournal.Step] = [
      .init(id: "permissions.screenRecording", state: .skipped, title: "Screen recording", fix: "Enable Stim Host"),
      .init(id: "permissions.deviceControl", state: .pending, title: "Device control"),
    ]
    _ = wizard.apply(.journalAnswered(port: 7443, journal: journal(steps: steps, done: true)), now: now)
    var host = status(.approved, id: "h")
    host.host = .init(name: "Mini", screenRecording: true, accessibility: false)
    _ = wizard.apply(.doctorReported(build: nil, host: host), now: now)
    XCTAssertEqual(wizard.journal?.steps.map(\.state), [.skipped, .pending], "The mirror shows what setup recorded")
    XCTAssertEqual(wizard.failure(now: now), .permissionSkipped(feature: "Hosted simulators cannot be controlled"))
    host.host?.accessibility = true
    _ = wizard.apply(.doctorReported(build: nil, host: host), now: now)
    XCTAssertNil(wizard.failure(now: now))
  }

  func testBothCapabilitiesCanBeTurnedOffButIssueNoCommand() {
    var wizard = SetupWizard()
    _ = wizard.apply(.macChosen(mac), now: now)
    _ = wizard.apply(.capabilitiesChanged([]), now: now)
    XCTAssertEqual(wizard.capabilities, [])
    XCTAssertEqual(wizard.apply(.next(ticket), now: now), [])
    XCTAssertEqual(wizard.phase, .choose)
    XCTAssertNil(wizard.ticket)
    XCTAssertEqual(previewLines(capabilities: [], known: SetupKnown()), [.init(text: "$ stim-server setup", kind: .command)])
    _ = wizard.apply(.capabilitiesChanged([.deviceHost]), now: now)
    _ = wizard.apply(.next(ticket), now: now)
    XCTAssertEqual(wizard.phase, .command)
  }

  func testBackgroundRefreshFollowsTheStepInPlaceOfACheckAgainButton() {
    var wizard = SetupWizard()
    XCTAssertEqual(wizard.refreshes(page: .setup), [.peers])
    _ = wizard.apply(.macChosen(mac), now: now)
    XCTAssertEqual(wizard.refreshes(page: .setup), [.approvals])
    _ = wizard.apply(.next(ticket), now: now)
    XCTAssertEqual(wizard.refreshes(page: .setup), [.journal])
    _ = wizard.apply(.journalAnswered(port: 7443, journal: journal()), now: now)
    _ = wizard.apply(.entriesWritten, now: now)
    XCTAssertEqual(wizard.refreshes(page: .setup), [.journal, .doctor])
    XCTAssertEqual(wizard.refreshes(page: .tools), [.tools])
    XCTAssertEqual(wizard.refreshes(page: .summary), [])
    _ = wizard.apply(.tick, now: ticket.expiresAt)
    XCTAssertEqual(wizard.phase, .expiredCommand)
    XCTAssertEqual(wizard.refreshes(page: .setup), [.doctor], "An expired ticket has no journal to read")
    _ = wizard.apply(.cancel, now: now)
    XCTAssertEqual(wizard.refreshes(page: .setup), [], "A cancelled setup reads nothing; a failed undo waits for Retry undo")

    var clock = SetupRefreshClock()
    XCTAssertEqual(clock.due([.journal, .doctor], now: now), [.journal, .doctor])
    XCTAssertEqual(clock.due([.journal, .doctor], now: now.addingTimeInterval(1)), [.journal])
    XCTAssertEqual(clock.due([.journal, .doctor], now: now.addingTimeInterval(5)), [.journal, .doctor])
    XCTAssertEqual(clock.due([.peers], now: now), [.peers])
    XCTAssertEqual(clock.due([.peers], now: now.addingTimeInterval(4)), [])
    clock.ran(.tools, now: now)
    XCTAssertEqual(clock.due([.tools], now: now.addingTimeInterval(9)), [])
    XCTAssertEqual(clock.due([.tools], now: now.addingTimeInterval(10)), [.tools])
  }

  func testNewCommandDoesNotTreatAMismatchedApprovalAsAlreadyDone() {
    var wizard = wizard(capabilities: [.build])
    _ = wizard.apply(.journalAnswered(port: 7443, journal: journal(grants: [.init(capability: .build, id: "other")])), now: now)
    _ = wizard.apply(.doctorReported(build: status(.approved, id: "this"), host: nil), now: now)
    XCTAssertFalse(wizard.known.buildApproved)
    _ = wizard.apply(.newCommand(ticket), now: now)
    XCTAssertEqual(wizard.phase, .command)
    XCTAssertFalse(wizard.known.buildApproved)
  }

  func testNewCommandKeepsEntriesAndUsesNewTicketForRequests() {
    var wizard = wizard()
    _ = wizard.apply(.journalAnswered(port: 7447, journal: journal()), now: now)
    _ = wizard.apply(.entriesWritten, now: now)
    let next = SetupTicket.generate(now: now.addingTimeInterval(1800), randomBytes: { $0 = [UInt8](repeating: 255, count: 32) })
    XCTAssertEqual(wizard.apply(.newCommand(next), now: now.addingTimeInterval(1800)), [])
    XCTAssertTrue(wizard.entriesWritten)
    XCTAssertEqual(wizard.port, 7447)
    XCTAssertEqual(wizard.ticket, next)
    XCTAssertEqual(
      wizard.apply(.journalAnswered(port: 7447, journal: journal()), now: now.addingTimeInterval(1801)),
      [.askDoctor(ticket: next.value)])
    XCTAssertEqual(
      wizard.apply(.doctorReported(build: status(.notAsked), host: nil), now: now.addingTimeInterval(1801)),
      [])
  }
}
