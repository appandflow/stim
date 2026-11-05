import Foundation
import Testing

@testable import StimKit

struct PairedMachinesTests {
  func workspace(_ path: String, live: Bool = true, build: String? = nil) throws -> Workspace {
    let build = build.map { ",\"build\":\($0)" } ?? ""
    return try JSONDecoder().decode(
      Workspace.self, from: Data("{\"path\":\"\(path)\",\"live\":\(live),\"warnings\":[]\(build)}".utf8))
  }

  func running(phase: String = "compile", planned: [String] = [], completed: [String] = []) -> String {
    let planned = planned.map { "{\"phase\":\"\($0)\",\"expectedMs\":1000}" }.joined(separator: ",")
    let completed = completed.map { "\"\($0)\":500" }.joined(separator: ",")
    return """
      {"platform":"ios","slot":"default","state":"running","phase":"\(phase)","startedAt":"2026-11-03T10:00:00.000Z",
       "phaseStartedAt":"2026-11-03T10:00:30.000Z","basis":0,"plannedPhases":[\(planned)],"completedPhaseMs":{\(completed)}}
      """
  }

  func pairing(_ name: String, capabilities: [String] = ["read"], seed: UInt8 = 1) -> PairedServer {
    PairedServer(
      endpoint: URL(string: "wss://\(name).example.invalid:7443")!, name: name,
      serverKey: Data(repeating: seed, count: 32), clientKey: Data(repeating: 9, count: 32), serverID: nil,
      capabilities: capabilities, pairedAt: Date(timeIntervalSince1970: 0))
  }

  func entry(_ pairing: PairedServer, _ connection: PairedServers.Connection = .open) -> PairedServers.Entry {
    PairedServers.Entry(id: pairing.id, kind: .pairing(pairing), connection: connection)
  }

  func payload(_ workspaces: [Workspace]) -> StatusPayload {
    var payload = try! JSONDecoder().decode(StatusPayload.self, from: Data(#"{"environments":[]}"#.utf8))
    payload.environments = workspaces
    return payload
  }

  func machines(
    _ entries: [PairedServers.Entry], reports: [String: (StatusPayload?, Bool)]
  ) -> [PairedMachine] {
    PairedMachine.list(entries: entries) { id in reports[id].map { (payload: $0.0, delivering: $0.1) } }
  }

  @Test func keepsOnlyThePairingsThatDeliverAndDropsTheWorkspacesOfTheOthers() throws {
    let open = pairing("floco", seed: 1)
    let offline = pairing("stale", seed: 2)
    let revoked = pairing("revoked", seed: 3)
    let silent = pairing("silent", seed: 4)
    let reported = payload([try workspace("/w/a")])
    let list = machines(
      [
        entry(open), entry(offline, .offline(reason: "gone", retryIn: 5, hadOpened: true)),
        entry(revoked, .refused(ServerError(code: "unauthorized", message: ""))), entry(silent),
      ],
      reports: [
        open.id: (reported, true), offline.id: (reported, false), revoked.id: (reported, false), silent.id: (reported, false),
      ])
    #expect(list.map(\.isAvailable) == [true, false, false, false])
    #expect(list.map(\.workspaces.count) == [1, 0, 0, 0])
  }

  @Test func dropsTheWorkspacesOfAnOpenPairingWhoseFeedStoppedDelivering() throws {
    let floco = pairing("floco")
    let list = machines([entry(floco)], reports: [floco.id: (payload([try workspace("/w/a")]), false)])
    #expect(list[0].isAvailable == false)
    #expect(list[0].workspaces.isEmpty)
  }

  @Test func readsViewOnlyAndViewAndControlFromThePairingsCapabilities() {
    let list = machines(
      [entry(pairing("a", capabilities: ["read"], seed: 1)), entry(pairing("b", capabilities: ["read", "control"], seed: 2))],
      reports: [:])
    #expect(list.map(\.canControl) == [false, true])
    #expect(list.map(\.accessTitle) == ["View Only", "View and Control"])
  }

  @Test func skipsAnUnreadableStoredItem() {
    let unreadable = PairedServers.Entry(id: "x", kind: .unreadable, connection: .unusable)
    #expect(machines([unreadable], reports: [:]).isEmpty)
  }

  func machine(_ name: String, seed: UInt8, canControl: Bool = false, workspaces: [Workspace], available: Bool = true)
    -> PairedMachine
  {
    PairedMachine(
      id: pairing(name, seed: seed).id, name: name, canControl: canControl, isAvailable: available, workspaces: workspaces)
  }

  @Test func listsThisMacsCardsFirstThenEachAvailableMachinesActiveWorkspacesLabelledByMachine() throws {
    let local = WallCard.cards(environments: [try workspace("/w/a")])
    let floco = machine(
      "floco", seed: 1, workspaces: [try workspace("/w/z"), try workspace("/w/b"), try workspace("/w/idle", live: false)])
    let down = machine("down", seed: 2, workspaces: [], available: false)
    let cards = WallCard.merged(local: local, machines: [floco, down], scope: .all)
    #expect(cards.map(\.apps[0].workspace.path) == ["/w/a", "/w/b", "/w/z"])
    #expect(cards.map(\.machine?.name) == [nil, "floco", "floco"])
    #expect(cards.map(\.owner.isLocal) == [true, false, false])
  }

  @Test func showsOnlyThisMacsCardsInTheThisMacScope() throws {
    let local = WallCard.cards(environments: [try workspace("/w/a")])
    let floco = machine("floco", seed: 1, workspaces: [try workspace("/w/b")])
    #expect(WallCard.merged(local: local, machines: [floco], scope: .thisMac).map(\.id) == ["/w/a"])
  }

  @Test func keepsTheCardsOfTwoMachinesThatReportOnePathApart() throws {
    let local = WallCard.cards(environments: [try workspace("/Users/me/app")])
    let floco = machine("floco", seed: 1, workspaces: [try workspace("/Users/me/app")])
    let other = machine("other", seed: 2, workspaces: [try workspace("/Users/me/app")])
    let cards = WallCard.merged(local: local, machines: [floco, other], scope: .all)
    #expect(Set(cards.map(\.id)).count == 3)
    #expect(Set(cards.map(\.choiceKey)).count == 3)
    #expect(cards[0].id == "/Users/me/app")
  }

  @Test func carriesTheAccessLevelOnTheCardSoAViewOnlyPairingNeverReadsAsControllable() throws {
    let viewOnly = machine("floco", seed: 1, workspaces: [try workspace("/w/a")])
    let control = machine("fig", seed: 2, canControl: true, workspaces: [try workspace("/w/a")])
    let cards = WallCard.merged(local: [], machines: [viewOnly, control], scope: .all)
    #expect(cards.map(\.machine?.canControl) == [false, true])
    #expect(cards.map(\.machine?.accessTitle) == ["View Only", "View and Control"])
  }

  @Test func listsRunningBuildsOfThisMacAndOfAvailableMachinesLabelledByMachine() throws {
    let local = [try workspace("/w/a", build: running()), try workspace("/w/b")]
    let floco = machine("floco", seed: 1, workspaces: [try workspace("/w/a", build: running(phase: "pods"))])
    let down = machine("down", seed: 2, workspaces: [], available: false)
    let all = RunningBuild.list(local: local, machines: [floco, down], scope: .all)
    #expect(all.map(\.machine) == [nil, "floco"])
    #expect(all.map(\.build.phase) == ["compile", "pods"])
    #expect(Set(all.map(\.id)).count == 2)
    #expect(RunningBuild.list(local: local, machines: [floco], scope: .thisMac).map(\.machine) == [nil])
  }

  @Test func ignoresBuildsThatAlreadyFinished() throws {
    let done = running().replacingOccurrences(of: "\"running\"", with: "\"done\"")
    #expect(RunningBuild.list(local: [try workspace("/w/a", build: done)], machines: [], scope: .all).isEmpty)
  }

  @Test func marksTheFinishedAndCurrentPhasesOfAPlannedBuild() throws {
    let build = try #require(
      try workspace(
        "/w/a",
        build: running(
          phase: "compile", planned: ["fingerprint", "pods", "compile", "install"], completed: ["fingerprint", "pods"])
      ).build)
    #expect(build.phaseSteps.map(\.phase) == ["fingerprint", "pods", "compile", "install"])
    #expect(build.phaseSteps.map(\.state) == [.done, .done, .current, .upcoming])
  }

  @Test func showsTheCurrentPhaseAloneWhenThePayloadCarriesNoPlan() throws {
    let build = try #require(try workspace("/w/a", build: running(phase: "wait")).build)
    #expect(build.phaseSteps == [BuildPhaseStep(phase: "wait", state: .current)])
  }

  @Test func countsActiveWorkspacesBuildsAndDevicesPerMachineAndNothingForAnUnavailableOne() throws {
    let ios = #","ios":{"udid":"i","name":"iPhone 17","owned":false,"state":"Booted"}"#
    let device = try JSONDecoder().decode(
      Workspace.self,
      from: Data(
        "{\"path\":\"/w/a\",\"live\":true,\"warnings\":[],\"build\":\(running())\(ios)}".utf8))
    let floco = machine("floco", seed: 1, workspaces: [try workspace("/w/b"), try workspace("/w/c", live: false)])
    let down = machine("down", seed: 2, workspaces: [], available: false)
    let tallies = MachineTally.list(local: [device], machines: [floco, down], scope: .all)
    #expect(tallies.map(\.name) == ["This Mac", "floco", "down"])
    #expect(tallies.map(\.activeWorkspaces) == [1, 1, 0])
    #expect(tallies.map(\.builds) == [1, 0, 0])
    #expect(tallies.map(\.devices) == [1, 0, 0])
    #expect(tallies.map(\.isAvailable) == [true, true, false])
    #expect(tallies.map(\.access) == [nil, "View Only", "View Only"])
  }

  @Test func offersNoTalliesWithoutAPairedMachineOrInTheThisMacScope() throws {
    #expect(MachineTally.list(local: [try workspace("/w/a")], machines: [], scope: .all).isEmpty)
    let floco = machine("floco", seed: 1, workspaces: [try workspace("/w/b")])
    #expect(MachineTally.list(local: [], machines: [floco], scope: .thisMac).isEmpty)
  }
}
