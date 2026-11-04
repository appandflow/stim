import Foundation
import StimKit
import Testing

struct ServerOwnerTests {
  private func workspace(path: String, udid: String) throws -> Workspace {
    let json = #"""
      {"path":"\#(path)","live":true,"warnings":[],
       "ios":{"name":"stim-app (iPhone 17 26.0)","udid":"\#(udid)","owned":true,"state":"Booted"},
       "android":{"name":"stim-app","serial":"emulator-5554","owned":true,"physical":false,"state":"detected"}}
      """#
    return try JSONDecoder().decode(Workspace.self, from: Data(json.utf8))
  }

  @Test func aPairedServersSimulatorNeverResolvesToOneOnThisMac() throws {
    let reported = try workspace(path: "/Users/me/app", udid: "1A2B")
    let local = OwnedWorkspace(owner: .local, workspace: reported)
    let paired = OwnedWorkspace(owner: .paired("SHA256:floco"), workspace: reported)

    #expect(local.devices.map(\.localSimulatorUDID) == ["1A2B", nil])
    #expect(local.devices.map(\.localEmulatorSerial) == [nil, "emulator-5554"])
    #expect(paired.devices.allSatisfy { $0.ref.hostedMachine == nil })
    #expect(paired.devices.allSatisfy { $0.localSimulatorUDID == nil && $0.localEmulatorSerial == nil })
    #expect(paired.devices.allSatisfy { $0.activityKey == nil })
  }

  @Test func theSameUDIDAndPathOnTwoServersKeepDistinctIdentities() throws {
    let reported = try workspace(path: "/Users/me/app", udid: "1A2B")
    let owners: [ServerOwner] = [.local, .paired("SHA256:floco"), .paired("SHA256:mini")]
    let workspaces = owners.map { OwnedWorkspace(owner: $0, workspace: reported) }

    #expect(Set(workspaces.map(\.id)).count == 3)
    #expect(Set(workspaces.flatMap(\.devices).map(\.id)).count == 6)
    #expect(workspaces[0].id == "/Users/me/app")
    #expect(workspaces[0].devices.map(\.id) == reported.devices.map(\.id))
    #expect(workspaces.map(\.key.localPath) == ["/Users/me/app", nil, nil])
  }

  @Test func aPairedServersOwnSimulatorOffersControlOnlyWhenThatServerGrantsIt() throws {
    let reported = try workspace(path: "/Users/me/app", udid: "1A2B")
    let control = ServerLink.open(features: [], capabilities: ["read", "control"])
    let readOnly = ServerLink.open(features: [], capabilities: ["read"])
    let local = OwnedWorkspace(owner: .local, workspace: reported).devices[0]
    let paired = OwnedWorkspace(owner: .paired("SHA256:floco"), workspace: reported).devices[0]

    #expect(local.offersControl(link: readOnly, now: Date()))
    #expect(paired.offersControl(link: control, now: Date()))
    #expect(!paired.offersControl(link: readOnly, now: Date()))
    #expect(!paired.offersControl(link: .connecting, now: Date()))
  }

  @Test func aPairedServersBrowserIsNeverDrivenThroughThisMacsChromeEndpoint() throws {
    let json = #"""
      {"path":"/Users/me/app","live":true,"warnings":[],
       "web":{"profile":"/Users/me/.stim/web","running":true,"headless":false,"pid":4242,
              "cdpEndpoint":"ws://127.0.0.1:9222/devtools/browser/x","targetId":"T1","url":"http://localhost:8081",
              "viewport":"1280x800"}}
      """#
    let reported = try JSONDecoder().decode(Workspace.self, from: Data(json.utf8))
    let control = ServerLink.open(features: [], capabilities: ["read", "control"])
    let local = try #require(OwnedWorkspace(owner: .local, workspace: reported).devices.first)
    let paired = try #require(OwnedWorkspace(owner: .paired("SHA256:floco"), workspace: reported).devices.first)

    #expect(local.isInteractive)
    #expect(!paired.isInteractive)
    #expect(!paired.offersControl(link: control, now: Date()))
  }

  private func hosted(path: String, session: String, build: Bool = false) throws -> Workspace {
    let placement =
      #"{"host":"janics-mac-mini-2:7443","phase":"pods","startedAt":"2026-10-27T10:00:00Z","phaseStartedAt":"2026-10-27T10:01:00Z"}"#
    let json = #"""
      {"path":"\#(path)","live":true,"warnings":[],
       "ios":{"name":"stim-app (iPhone 17 27.0)","udid":"","owned":false,"state":"ready",
              "host":{"machine":"janics-mac-mini-2:7443","session":"\#(session)"}},
       "build":\#(build ? #"{"platform":"android","slot":"default","state":"running","phase":"compile","startedAt":"2026-10-27T10:00:00Z","phaseStartedAt":"2026-10-27T10:00:30Z","basis":0,"placement":\#(placement)}"# : "null")}
      """#
    return try JSONDecoder().decode(Workspace.self, from: Data(json.utf8))
  }

  @Test func workThisMachinePlacesAndWorkAPairedServerPlacesNeverShareAList() throws {
    let floco = ServerOwner.paired("floco-key")
    let workspaces = [
      OwnedWorkspace(owner: .local, workspace: try hosted(path: "/Users/me/app", session: "s-local")),
      OwnedWorkspace(owner: floco, workspace: try hosted(path: "/home/bot/app", session: "s-bot", build: true)),
      OwnedWorkspace(owner: .paired("other-key"), workspace: try hosted(path: "/home/bot/app", session: "s-bot")),
    ]

    let placed = PlacedWork.list(workspaces)
    #expect(placed.map(\.workspace) == ["/Users/me/app"])
    #expect(placed.map(\.host) == ["janics-mac-mini-2"])

    let theirs = ForeignWork.list(workspaces, server: "floco-key")
    #expect(theirs.map(\.workspace) == ["/home/bot/app", "/home/bot/app"])
    #expect(theirs.map(\.host) == ["janics-mac-mini-2", "janics-mac-mini-2"])
    guard case .offloadedBuild(let build) = theirs[1].kind else {
      Issue.record("the offloaded build is missing")
      return
    }
    #expect(build.platform == "android")
    #expect(Set(placed.map(\.id) + theirs.map(\.id)).count == 3)
    #expect(ForeignWork.list(workspaces, server: "other-key").isEmpty)
  }

  @Test func ownedPlacementAndForeignWorkReadDifferentlyForTheSameMachine() throws {
    let workspaces = [
      OwnedWorkspace(owner: .local, workspace: try hosted(path: "/Users/me/app", session: "s-local")),
      OwnedWorkspace(owner: .paired("floco-key"), workspace: try hosted(path: "/home/bot/app", session: "s-bot", build: true)),
    ]
    let mine = try #require(PlacedWork.list(workspaces).first)
    let theirs = ForeignWork.list(workspaces, server: "floco-key")

    #expect(mine.badge == "on janics-mac-mini-2")
    #expect(mine.place(now: Date()) == "running on janics-mac-mini-2")
    #expect(
      theirs.map { $0.place(serverName: "floco", now: Date()) } == [
        "floco runs it on janics-mac-mini-2", "floco builds it on janics-mac-mini-2 \u{00B7} Pods",
      ])
    let badges = workspaces.compactMap { $0.devices.first?.placementBadge }
    #expect(badges.map(\.text) == ["on janics-mac-mini-2", "theirs, on janics-mac-mini-2"])
    #expect(badges.map(\.owned) == [true, false])
    #expect(
      badges.map(\.accessibilityLabel) == [
        "Yours, running on janics-mac-mini-2", "Theirs, running on janics-mac-mini-2",
      ])
  }

  @Test func aMachineThatIsBothRemoteAndPairedGetsTwoChipsWithDisjointWork() throws {
    let workspaces = [
      OwnedWorkspace(owner: .local, workspace: try hosted(path: "/Users/me/app", session: "s-mine")),
      OwnedWorkspace(owner: .paired("mini-key"), workspace: try hosted(path: "/home/mini/app", session: "s-theirs")),
    ]

    let chips = MachineChoices.groups(remote: ["janics-mac-mini-2:7443"], paired: ["mini-key"]).flatMap(\.choices)
    #expect(chips == [.thisMachine, .remote("janics-mac-mini-2:7443"), .paired("mini-key")])

    let placed = PlacedWork.list(workspaces).filter { $0.isOn("janics-mac-mini-2:7443") }
    let theirs = ForeignWork.list(workspaces, server: "mini-key")
    #expect(placed.map(\.workspace) == ["/Users/me/app"])
    #expect(theirs.map(\.workspace) == ["/home/mini/app"])
    #expect(Set(placed.map(\.id) + theirs.map(\.id)).count == 2)
  }

  @Test func placedWorkBelongsToTheRemoteMachineEntryThatNamesItsHost() throws {
    let mine = try #require(
      PlacedWork.list([OwnedWorkspace(owner: .local, workspace: try hosted(path: "/Users/me/app", session: "s"))]).first)

    #expect(mine.isOn("janics-mac-mini-2:7443"))
    #expect(mine.isOn("janics-mac-mini-2.tail1.ts.net"))
    #expect(!mine.isOn("janics-mac-mini:7443"))
  }

  @Test func aPairedServersSidebarIgnoresThisMacsHiddenPathsAndHidesOnlyItsOwn() throws {
    var shared = try workspace(path: "/Users/me/app", udid: "1A2B")
    shared.hidden = true
    let other = try workspace(path: "/Users/me/other", udid: "3C4D")
    var options = SidebarOptions()
    options.statuses = [.live, .idle]
    options.hiddenWorkspaces = HiddenWorkspaces(paths: ["/Users/me/app"])
    options.hiddenProjects = ["/Users/me/other"]

    let shown = pairedSidebarTrees(environments: [shared, other], options: options, hidden: [])
    #expect(Set(shown.flatMap(\.entries).map(\.path)) == ["/Users/me/app", "/Users/me/other"])

    let hidden = pairedSidebarTrees(environments: [shared, other], options: options, hidden: ["/Users/me/other"])
    #expect(hidden.flatMap(\.entries).map(\.path) == ["/Users/me/app"])
  }

  @Test func countsPastIntsRangeFromAPairedServerDoNotTrap() throws {
    let huge = try ["a", "b"].map { name in
      try JSONDecoder().decode(
        Workspace.self,
        from: Data(
          #"""
          {"path":"/home/bot/app/.worktrees/\#(name)","live":true,"warnings":[],"memoryMb":5000000000000000000,
           "worktree":{"path":"/home/bot/app/.worktrees/\#(name)","git":{"changed":5000000000000000000,"untracked":5000000000000000000}}}
          """#.utf8))
    }
    var options = SidebarOptions()
    for sort in SidebarSort.allCases {
      options.sort = sort
      let trees = pairedSidebarTrees(environments: huge, options: options, hidden: [])
      #expect(trees.map(\.summary.project.root) == ["/home/bot/app"])
      #expect(trees.flatMap(\.entries).count == 2)
    }
    #expect(huge.map { $0.worktree?.git?.uncommitted } == [Int.max, Int.max])
  }
}
