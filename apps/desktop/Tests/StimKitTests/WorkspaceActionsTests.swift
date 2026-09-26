import Foundation
import Testing

@testable import StimKit

@Suite struct WorkspaceMenuItemsTests {
  @Test func workspaceRowOffersStartWhenMetroIsStopped() {
    let items = workspaceMenuItems(for: .workspace(metroRunning: false, platforms: ["ios"])).compactMap { $0 }
    #expect(items.contains(.run(platform: "ios")))
    #expect(!items.contains(.run(platform: "android")))
    #expect(items.contains(.startDevServer))
    #expect(!items.contains(.stopDevServer))
    #expect(items.contains(.reload))
    #expect(items.contains(.showLogs))
    #expect(items.contains(.removeWorktree))
    #expect(!items.contains(.warmWorktree))
  }

  @Test func workspaceRowOffersStopWhenMetroIsRunning() {
    let items = workspaceMenuItems(for: .workspace(metroRunning: true, platforms: [])).compactMap { $0 }
    #expect(items.contains(.stopDevServer))
    #expect(!items.contains(.startDevServer))
  }

  @Test func worktreeRowSkipsServerActionsAndOffersWarm() {
    let items = workspaceMenuItems(for: .worktree).compactMap { $0 }
    #expect(items.contains(.warmWorktree))
    #expect(items.contains(.removeWorktree))
    #expect(!items.contains(.reload))
    #expect(!items.contains(.run(platform: "ios")))
    #expect(!items.contains(.startDevServer))
    #expect(!items.contains(.stopDevServer))
    #expect(!items.contains(.showLogs))
    #expect(!items.contains(.lastOutput))
  }

  @Test func projectRowOnlyOffersFileActionsAndStopAll() {
    let items = workspaceMenuItems(for: .project).compactMap { $0 }
    #expect(items == [.revealInFinder, .copyPath, .stopAllLiveWorkspaces])
  }
}

@Suite struct WorkspaceRunTests {
  private func workspace(_ fields: String) throws -> Workspace {
    try JSONDecoder().decode(Workspace.self, from: Data(#"{"path":"/w","live":true,"warnings":[]\#(fields)}"#.utf8))
  }

  @Test func runOffersThePlatformsTheWorkspaceUsesOrBoth() throws {
    #expect(try workspace("").runPlatforms == ["ios", "android"])
    let android = try workspace(#","android":{"name":"stim-w","owned":true,"physical":false,"state":"not-detected"}"#)
    #expect(android.runPlatforms == ["android"])
    let built = try workspace(
      #","lastBuilds":{"ios":{"platform":"ios","status":"failed","cacheHit":false,"cacheSkipped":false,"durationMs":1,"fingerprint":null,"startedAt":"2026-09-26T00:00:00Z","finishedAt":null}}"#
    )
    #expect(built.runPlatforms == ["ios"])
  }

  @Test func reloadNeedsTheDevServerAndARunningLocalDevice() throws {
    let metro = #","metro":{"port":8081,"running":true,"pid":1}"#
    let booted = #","ios":{"name":"stim-w (iPhone 18 Pro 27.0)","udid":"A","owned":true,"state":"Booted"}"#
    let shutdown = #","ios":{"name":"stim-w (iPhone 18 Pro 27.0)","udid":"A","owned":true,"state":"Shutdown"}"#
    #expect(try workspace(metro + booted).canReload)
    #expect(!(try workspace(metro + shutdown).canReload))
    #expect(!(try workspace(booted).canReload))
  }

  @Test func aStoppedAppNeedsRunNotReload() throws {
    let stopped = try workspace(
      #","metro":{"port":8081,"running":true,"pid":1},"slots":[{"slot":"duo","ios":{"name":"stim-w-duo (iPhone Duo 27.1)","udid":"B","owned":true,"state":"Booted","app":{"id":"com.example.app","state":"stopped"}}}]"#
    )
    let device = try #require(stopped.devices.first)
    #expect(device.appStopped)
    #expect(!stopped.canReload)
    #expect(runCommand(for: device, cwd: "/w")?.arguments == ["ios", "--slot", "duo"])
    let unknown = try workspace(
      #","metro":{"port":8081,"running":true,"pid":1},"android":{"name":"stim-w","owned":true,"physical":false,"serial":"emulator-5554","state":"detected","app":{"id":"com.example.app","state":"unknown"}}"#
    )
    let emulator = try #require(unknown.devices.first)
    #expect(!emulator.appStopped)
    #expect(unknown.canReload)
    #expect(runCommand(for: emulator, cwd: "/w")?.arguments == ["android"])
  }

  @Test func offersNoRunForAPhysicalOrUnownedDevice() throws {
    let phone = try workspace(
      #","android":{"name":"Pixel 9","owned":false,"physical":true,"serial":"4B1C0012","state":"detected","app":{"id":"com.example.app","state":"stopped"}}"#
    )
    let iphone = try workspace(
      #","ios":{"name":"Janic's iPhone","udid":"00008120-001","owned":false,"state":"Booted","app":{"id":"com.example.app","state":"stopped"}}"#
    )
    for device in [try #require(phone.devices.first), try #require(iphone.devices.first)] {
      #expect(device.appStopped)
      #expect(runCommand(for: device, cwd: "/w") == nil)
    }
  }
}

@Suite struct WorktreeRemovalAllowedTests {
  @Test func allowsRemovalWithNoGitInfo() {
    #expect(worktreeRemovalAllowed(git: nil))
  }

  @Test func allowsRemovalWhenCleanAndPushed() {
    let git = WorktreeGit(changed: 0, untracked: 0, ahead: 0)
    #expect(worktreeRemovalAllowed(git: git))
  }

  @Test func blocksRemovalWithUncommittedChanges() {
    let git = WorktreeGit(changed: 1, untracked: 0)
    #expect(!worktreeRemovalAllowed(git: git))
  }

  @Test func blocksRemovalWithUnpushedCommits() {
    let git = WorktreeGit(changed: 0, untracked: 0, ahead: 2)
    #expect(!worktreeRemovalAllowed(git: git))
  }
}
