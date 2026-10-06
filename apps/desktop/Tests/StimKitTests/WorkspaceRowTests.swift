import Foundation
import Testing

@testable import StimKit

@Suite struct WorkspaceRowVectorTests {
  struct Vectors: Decodable {
    struct Status: Decodable, Equatable {
      var kind: String
      var text: String
      var label: String
      var tone: String
    }

    struct Problem: Decodable, Equatable {
      var kind: String
      var text: String
      var tone: String
    }

    struct Idle: Decodable, Equatable {
      var text: String
      var label: String
    }

    struct Devices: Decodable, Equatable {
      var names: String?
      var drivers: String?
      var idle: Idle?
      var remote: Int
    }

    struct Case: Decodable {
      var name: String
      var workspace: Workspace
      var status: Status
      var problems: [Problem]
      var devices: Devices
    }

    var now: String
    var cases: [Case]
  }

  static let vectors: Vectors = {
    let url = Bundle.module.url(forResource: "workspace-row-vectors", withExtension: "json", subdirectory: "Fixtures")!
    return try! JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
  }()

  static let now = parseTimestamp(vectors.now)!

  @Test(arguments: vectors.cases.map(\.name))
  func summarizesTheRowAsThePhoneDoes(name: String) throws {
    let c = try #require(Self.vectors.cases.first { $0.name == name })
    let status = c.workspace.rowStatus(now: Self.now)
    #expect(
      Vectors.Status(
        kind: status.kind.rawValue, text: status.text, label: status.label, tone: String(describing: status.tone))
        == c.status)
    #expect(
      c.workspace.rowProblems(now: Self.now).map {
        Vectors.Problem(kind: $0.kind.rawValue, text: $0.text, tone: String(describing: $0.tone))
      } == c.problems)
    let devices = c.workspace.rowDevices(now: Self.now)
    #expect(
      Vectors.Devices(
        names: devices.names, drivers: devices.drivers,
        idle: devices.idle.map { Vectors.Idle(text: $0.text, label: $0.label) }, remote: devices.remote) == c.devices)
  }
}

@Suite struct WorkspaceRowLabelTests {
  static let now = parseTimestamp("2026-09-30T12:00:00.000Z")!

  static func workspace(_ fields: String) throws -> Workspace {
    let json = #"{"path":"/w","live":true,"memoryMb":0,"warnings":[],\#(fields)}"#
    return try JSONDecoder().decode(Workspace.self, from: Data(json.utf8))
  }

  static let driven =
    #"{"name":"stim-w (iPhone 18 27.0)","udid":"SIM-1","owned":true,"state":"Booted","activity":{"state":"driven","driver":{"tool":"agent-device","since":"2026-09-30T11:55:00.000Z"},"basis":[]}}"#

  @Test func speaksTheBuildStepErrorsAndEachDriver() throws {
    let env = try Self.workspace(
      #""build":{"platform":"ios","slot":"default","state":"running","phase":"compile","startedAt":"2026-09-30T11:59:00.000Z","phaseStartedAt":"2026-09-30T11:59:30.000Z","outcome":"cold","basis":0,"detail":{"step":"compile","unit":"targets","done":97,"total":214}},"logs":{"dir":"","errorsSinceMarker":2},"ios":\#(Self.driven)"#
    )
    #expect(
      env.rowLabel(now: Self.now, folder: nil, showsGit: false)
        == "w, Building iOS, Compiling, 97 of 214 targets, 2 errors, iOS, driven by agent-device for 5 minutes")
  }

  @Test func summarizesEveryAppWhileUsingTheUrgentAppsStatusAndDeduplicatingSharedFacts() throws {
    let worktree =
      #"{"path":"/w","branch":"topic","git":{"changed":0,"untracked":0,"upstream":"origin/topic","ahead":0,"behind":0},"pullRequest":{"number":7,"url":"https://example.test/7","title":"Topic","state":"open","checks":{"passing":0,"failing":1,"pending":0}}}"#
    let agent = #"{"tool":"codex","sessionId":"shared","cwd":"/w","title":"Fix","startedAt":"2026-09-30T10:00:00.000Z"}"#
    var envs = try JSONDecoder().decode(
      [Workspace].self,
      from: Data(
        #"""
        [
          {"path":"/w/b","live":true,"warnings":[],"worktree":\#(worktree),"ios":\#(Self.driven),
            "build":{"platform":"ios","slot":"default","state":"running","phase":"compile","startedAt":"2026-09-30T11:59:00.000Z","phaseStartedAt":"2026-09-30T11:59:00.000Z","outcome":"cold","basis":0},
            "logs":{"dir":"/b","errorsSinceMarker":2},"agents":[\#(agent)],
            "endedAgents":[{"tool":"claude-code","sessionId":"other","cwd":"/w","startedAt":"2026-09-30T11:00:00.000Z"}],
            "remoteDevices":[{"platform":"ios","backend":"eas","sessionId":"B","state":"running"},
              {"platform":"ios","backend":"eas","sessionId":"C","state":"running"}]},
          {"path":"/w/a","live":true,"warnings":[],"worktree":\#(worktree),"ios":\#(Self.driven),
            "logs":{"dir":"/a","errorsSinceMarker":2},"agents":[\#(agent)],
            "remoteDevices":[{"platform":"ios","backend":"eas","sessionId":"A","state":"running"}]}
        ]
        """#.utf8))
    let page = try #require(WorktreePage(path: "/w/b", environments: envs))
    let summary = page.rowSummary(now: Self.now, subtitle: "Repo", showsGit: true)
    #expect(summary.title == "topic")
    #expect(summary.status.kind == .driven)
    #expect(summary.status.tone == .brand)
    #expect(summary.active)
    #expect(summary.apps.map(\.label) == ["iOS \u{00B7} a", "iOS \u{00B7} b"])
    #expect(summary.apps.map(\.status.kind) == [.driven, .building])
    #expect(summary.apps.map(\.active) == [true, true])
    #expect(summary.drivers == "agent-device")
    #expect(summary.remote == 3)
    #expect(summary.problems == ["4 errors", "CI failing"])
    #expect(summary.agents.map(\.id) == ["codex:shared", "claude-code:other"])
    let spoken =
      "topic, Driven by an agent for 5 minutes, iOS \u{00B7} a: Driven by an agent for 5 minutes, iOS \u{00B7} b: Building iOS, Codex \u{00B7} Fix +1, 4 errors, CI failing, driven by agent-device, 3 EAS sessions"
    #expect(summary.label == spoken + ", Pull request 7, open, checks failing, Repo")
    #expect(page.rowSummary(now: Self.now, subtitle: nil, showsGit: false).label == spoken)

    envs[1].logs = nil
    let building = try #require(WorktreePage(path: "/w/a", environments: envs))
    #expect(building.id == page.id)
    #expect(building.rowSummary(now: Self.now, subtitle: nil, showsGit: false).status.kind == .building)
    for index in envs.indices {
      envs[index].live = false
      envs[index].build = nil
      envs[index].remoteDevices = nil
      envs[index].logs = nil
    }
    let idle = try #require(WorktreePage(path: "/w/a", environments: envs)).rowSummary(
      now: Self.now, subtitle: nil, showsGit: false)
    #expect(!idle.active)
    #expect(idle.apps.map(\.active) == [false, false])
    #expect(idle.status.kind == .idle)
    #expect(idle.status.tone == .tertiary)
  }

  @Test func headlinesALiveAppEvenWhenAStoppedAppRanksFirstByItsFailedBuild() throws {
    let envs = try JSONDecoder().decode(
      [Workspace].self,
      from: Data(
        #"""
        [
          {"path":"/w/a","live":false,"warnings":[],"worktree":{"path":"/w"},
            "lastBuilds":{"ios":{"platform":"ios","status":"failed","cacheHit":false,"cacheSkipped":false,"durationMs":1,"fingerprint":null,"startedAt":"2026-09-01T00:00:00Z","finishedAt":null}}},
          {"path":"/w/b","live":true,"warnings":[],"worktree":{"path":"/w"},"logs":{"dir":"/b","errorsSinceMarker":3}}
        ]
        """#.utf8))
    let page = try #require(WorktreePage(path: "/w/a", environments: envs))
    #expect(page.lead(now: Self.now).path == "/w/a")
    let summary = page.rowSummary(now: Self.now, subtitle: nil, showsGit: false)
    #expect(summary.status.kind == .running)
    #expect(summary.problems == ["3 errors"])
  }

  @Test func speaksADrivenWorkspaceOnceThroughItsDevices() throws {
    let env = try Self.workspace(
      #""ios":\#(Self.driven),"slots":[{"slot":"ipad","ios":{"name":"stim-w (iPad 27.0)","udid":"SIM-2","owned":true,"state":"Booted"}}]"#
    )
    #expect(
      env.rowLabel(now: Self.now, folder: "apps/mobile", showsGit: false)
        == "w, iOS, driven by agent-device for 5 minutes, iOS slot ipad running, apps/mobile")
  }
}
