import Foundation
import StimKit
import Testing

struct WorktreePageTests {
  struct Vectors: Decodable {
    struct Input: Decodable {
      var now: String
      var path: String
      var environments: [Workspace]
      var entries: [WorktreePage.Entry]
    }
    struct Expected: Decodable {
      var apps: [String]
      var projects: [String]
      var lead: String
      var subtitles: [String?]
      var appLabels: [String]
    }
    struct Case: Decodable {
      var name: String
      var input: Input
      var expected: Expected
    }
    var cases: [Case]
  }

  static let vectors: Vectors = {
    let url = Bundle.module.url(forResource: "worktree-page-vectors", withExtension: "json", subdirectory: "Fixtures")!
    return try! JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
  }()

  @Test(arguments: vectors.cases.map(\.name))
  func matchesSharedRule(name: String) throws {
    let c = try #require(Self.vectors.cases.first { $0.name == name })
    let page = try #require(WorktreePage(path: c.input.path, environments: c.input.environments))
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let now = try #require(formatter.date(from: c.input.now))
    #expect(page.apps.map(\.path) == c.expected.apps)
    #expect(page.projects == c.expected.projects)
    #expect(page.lead(now: now).path == c.expected.lead)
    #expect(page.subtitles(entries: c.input.entries) == c.expected.subtitles)
    #expect(page.appLabels(entries: c.input.entries) == c.expected.appLabels)
  }

  @Test func singleAppUsesPlainPresentationWithoutSubtitles() throws {
    let c = Self.vectors.cases[0]
    let page = try #require(WorktreePage(path: c.input.path, environments: c.input.environments))
    #expect(!page.isUnified)
    for entries in [c.input.entries, page.buildEntries, page.canvasEntries] {
      #expect(page.subtitles(entries: entries).allSatisfy { $0 == nil })
    }
  }

  @Test func aggregatesCountSharedDiskOnceAndAlignLatestSamples() throws {
    let environments = try JSONDecoder().decode(
      [Workspace].self,
      from: Data(
        """
        [
          {"path":"/w/apps/a","live":true,"warnings":[],"worktree":{"path":"/w"},"memoryMb":100,
            "disk":{"worktreeBytes":1000,"nodeModulesBytes":600,"buildBytes":200},"logs":{"dir":"/a","errorsSinceMarker":2}},
          {"path":"/w/apps/b","live":true,"warnings":[],"worktree":{"path":"/w"},"memoryMb":200,
            "disk":{"worktreeBytes":1200,"nodeModulesBytes":700,"buildBytes":300},"logs":{"dir":"/b","errorsSinceMarker":3}}
        ]
        """.utf8))
    let page = try #require(WorktreePage(path: "/w/apps/b", environments: environments))
    let usage = page.usage(machine: nil, sampled: ["/w/apps/a": .init(cpuPercent: 5), "/w/apps/b": .init(cpuPercent: 7)])
    #expect(usage == WorkspaceUsage(cpuPercent: 12, memoryMb: 300, diskBytes: 1700))
    #expect(page.diskBreakdown?.parts.map(\.bytes) == [700, 500, 500])
    #expect(page.errors == 5)
    #expect(WorktreePage.summedHistory([[1, 2, 3], [10, 20]]) == [1, 12, 23])
    #expect(WorktreePage.summedHistory([[], [4]]) == [4])
  }

  @Test func mergedDevicesKeepTheirOwnerAndSingleAppOrder() throws {
    let environments = try JSONDecoder().decode(
      [Workspace].self,
      from: Data(
        """
        [
          {"path":"/w/a","live":true,"warnings":[],"worktree":{"path":"/w"},
            "android":{"name":"a","owned":true,"physical":false,"state":"device"},"ios":{"udid":"a","owned":true,"state":"Booted"}},
          {"path":"/w/b","live":true,"warnings":[],"worktree":{"path":"/w"},
            "ios":{"udid":"b","owned":true,"state":"Booted"}}
        ]
        """.utf8))
    let page = try #require(WorktreePage(path: "/w/a", environments: environments))
    #expect(page.orderedDevices.map { $0.device.platform } == ["ios", "ios", "android"])
    #expect(page.orderedDevices.map { $0.workspace.path } == ["/w/a", "/w/b", "/w/a"])
    #expect(
      page.buildEntries == [
        .init(path: "/w/a", platform: "ios"), .init(path: "/w/b", platform: "ios"), .init(path: "/w/a", platform: "android"),
      ])
    #expect(page.subtitles(entries: page.buildEntries) == ["a", "b", nil])
    let single = try #require(WorktreePage(path: "/w/a", environments: [environments[0]]))
    #expect(single.orderedDevices.map(\.device) == environments[0].orderedDevices)
  }

  @Test func unmeasuredTotalsStayUnknown() throws {
    let c = Self.vectors.cases[1]
    let page = try #require(WorktreePage(path: c.input.path, environments: c.input.environments))
    #expect(page.usage(machine: nil).isEmpty)
    #expect(page.errors == nil)
    #expect(page.diskBreakdown == nil)
  }

  @Test func sharedAgentSessionsAppearOnceInAssociatedOrder() throws {
    let environments = try JSONDecoder().decode(
      [Workspace].self,
      from: Data(
        """
        [
          {"path":"/w/a","live":true,"warnings":[],"worktree":{"path":"/w"},
            "agents":[{"tool":"codex","sessionId":"shared","cwd":"/w","startedAt":"2026-10-05T10:00:00.000Z"}],
            "endedAgents":[{"tool":"codex","sessionId":"undated","cwd":"/w"}]},
          {"path":"/w/b","live":true,"warnings":[],"worktree":{"path":"/w"},
            "agents":[{"tool":"codex","sessionId":"shared","cwd":"/w","startedAt":"2026-10-05T10:00:00.000Z"},
              {"tool":"claude-code","sessionId":"first","cwd":"/w","startedAt":"2026-10-05T09:00:00.000Z"},
              {"tool":"claude-code","sessionId":"shared","cwd":"/w","startedAt":"2026-10-05T08:00:00.000Z"}]}
        ]
        """.utf8))
    let page = try #require(WorktreePage(path: "/w/a", environments: environments))
    #expect(page.agents.map(\.id) == ["claude-code:shared", "claude-code:first", "codex:shared", "codex:undated"])
  }

  @Test func pageIdentitySurvivesAnEarlierAppJoining() throws {
    let environments = try JSONDecoder().decode(
      [Workspace].self,
      from: Data(
        """
        [
          {"path":"/w/a","live":true,"warnings":[],"worktree":{"path":"/w"}},
          {"path":"/w/b","live":true,"warnings":[],"worktree":{"path":"/w"}},
          {"path":"/w/c","live":true,"warnings":[],"worktree":{"path":"/w"}}
        ]
        """.utf8))
    let before = try #require(WorktreePage(path: "/w/b", environments: Array(environments.dropFirst())))
    let after = try #require(WorktreePage(path: "/w/b", environments: environments))
    #expect(before.identity == after.identity)
    #expect(after.identity == "/w")
    #expect(before.id != after.id)
  }

  @Test func scrollsToTheSelectedAppInGlobalCanvasOrderAndHonorsDeviceLinks() throws {
    var environments = try JSONDecoder().decode(
      [Workspace].self,
      from: Data(
        """
        [
          {"path":"/w/a","live":true,"warnings":[],"worktree":{"path":"/w"},
            "android":{"name":"a","owned":true,"physical":false,"state":"device"}},
          {"path":"/w/b","live":true,"warnings":[],"worktree":{"path":"/w"},
            "ios":{"udid":"b","owned":true,"state":"Booted"},
            "slots":[{"slot":"other","ios":{"udid":"other","owned":true,"state":"Booted"}}]}
        ]
        """.utf8))
    let page = try #require(WorktreePage(path: "/w/a", environments: environments))
    let devices = page.orderedDevices
    #expect(page.canvasScrollTarget(selectedPath: "/w/a", focusedID: nil, devices: devices) == "/w/a|android:default:a")
    #expect(page.canvasScrollTarget(selectedPath: "/w/b", focusedID: nil, devices: devices) == nil)
    #expect(page.canvasScrollTarget(selectedPath: "/w/b", focusedID: "ios:other", devices: devices) == "/w/b|ios:other")
    #expect(page.canvasScrollTarget(selectedPath: "/w/a", focusedID: "ios:other", devices: devices) == "/w/a|android:default:a")
    let macos = try JSONDecoder().decode(
      MacosApp.self,
      from: Data(
        """
        {"launchId":"m","product":"App","bundle":"/App.app","bundleId":"dev.app","executable":"/App.app/App",
          "state":"running","build":{"state":"ok","startedAt":"2026-10-05T09:00:00.000Z"}}
        """.utf8))
    environments[0].macos = macos
    let withCard = try #require(WorktreePage(path: "/w/b", environments: environments))
    #expect(withCard.canvasScrollTarget(selectedPath: "/w/b", focusedID: nil, devices: withCard.orderedDevices) == "/w/b|ios:b")

    environments[0].android = nil
    environments[1].ios = nil
    environments[1].slots = nil
    environments[1].macos = macos
    let cardsOnly = try #require(WorktreePage(path: "/w/b", environments: environments))
    #expect(cardsOnly.canvasScrollTarget(selectedPath: "/w/a", focusedID: nil, devices: []) == nil)
    #expect(cardsOnly.canvasScrollTarget(selectedPath: "/w/b", focusedID: nil, devices: []) == "macos|/w/b")

  }

  @Test func toolbarSelectsAnAppOnlyWhenItAloneHasErrors() throws {
    var environments = try JSONDecoder().decode(
      [Workspace].self,
      from: Data(
        """
        [
          {"path":"/w/a","live":true,"warnings":[],"worktree":{"path":"/w"}},
          {"path":"/w/b","live":true,"warnings":[],"worktree":{"path":"/w"},"logs":{"dir":"/b","errorsSinceMarker":2}}
        ]
        """.utf8))
    var page = try #require(WorktreePage(path: "/w/a", environments: environments))
    #expect(page.soleErrorApp?.path == "/w/b")
    environments[0].logs = environments[1].logs
    page = try #require(WorktreePage(path: "/w/a", environments: environments))
    #expect(page.soleErrorApp == nil)
    environments[0].logs = nil
    environments[1].logs = nil
    page = try #require(WorktreePage(path: "/w/a", environments: environments))
    #expect(page.soleErrorApp == nil)
  }

}
