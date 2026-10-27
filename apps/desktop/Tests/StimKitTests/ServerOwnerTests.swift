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

  @Test func aHostedSessionTwoServersReportShowsOnceUnderTheFirstAndEachRunNamesWhereItRuns() throws {
    let floco = ServerOwner.paired("floco-key")
    let workspaces = [
      OwnedWorkspace(owner: .local, workspace: try hosted(path: "/Users/me/app", session: "s-local")),
      OwnedWorkspace(owner: floco, workspace: try hosted(path: "/home/bot/app", session: "s-bot", build: true)),
      OwnedWorkspace(owner: .paired("other-key"), workspace: try hosted(path: "/home/bot/app", session: "s-bot")),
    ]

    let work = RemoteWork.list(workspaces)

    #expect(work.map(\.owner) == [.local, floco, floco])
    #expect(work.map(\.host) == ["janics-mac-mini-2", "janics-mac-mini-2", "janics-mac-mini-2"])
    #expect(work.map(\.workspace.path) == ["/Users/me/app", "/home/bot/app", "/home/bot/app"])
    guard case .offloadedBuild(let build) = work[2].kind else {
      Issue.record("the offloaded build is missing")
      return
    }
    #expect(build.platform == "android")
    #expect(Set(work.map(\.id)).count == 3)
  }

  @Test func aPairedServersSidebarIgnoresThisMacsHiddenPathsAndHidesOnlyItsOwn() throws {
    let shared = try workspace(path: "/Users/me/app", udid: "1A2B")
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
}
