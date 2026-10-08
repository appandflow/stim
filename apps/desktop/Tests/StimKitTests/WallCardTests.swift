import Foundation
import Testing

@testable import StimKit

struct WallCardTests {
  func workspace(_ path: String, worktree: String? = nil) throws -> Workspace {
    let tree = worktree.map { ",\"worktree\":{\"path\":\"\($0)\"}" } ?? ""
    return try JSONDecoder().decode(
      Workspace.self, from: Data("{\"path\":\"\(path)\",\"live\":false,\"warnings\":[]\(tree)}".utf8))
  }

  @Test func givesAWorktreeWithOneAppOneCard() throws {
    let cards = WallCard.cards(environments: [try workspace("/w/a", worktree: "/w/a")])
    #expect(cards.count == 1)
    #expect(cards[0].isMultiApp == false)
    #expect(cards[0].apps.map(\.label) == ["a"])
    #expect(cards[0].id == "/w/a")
  }

  @Test func groupsTheAppsOfOneWorktreeIntoOneCard() throws {
    let cards = WallCard.cards(environments: [
      try workspace("/w/a/apps/mobile", worktree: "/w/a"),
      try workspace("/w/a/apps/desktop", worktree: "/w/a"),
    ])
    #expect(cards.count == 1)
    #expect(cards[0].isMultiApp)
    #expect(cards[0].apps.map(\.label) == ["apps/desktop", "apps/mobile"])
    #expect(cards[0].apps.map(\.workspace.path) == ["/w/a/apps/desktop", "/w/a/apps/mobile"])
  }

  @Test func keepsTwoWorktreesOfOneProjectApart() throws {
    let cards = WallCard.cards(environments: [
      try workspace("/w/a/apps/mobile", worktree: "/w/a"),
      try workspace("/w/b/apps/mobile", worktree: "/w/b"),
      try workspace("/w/a/apps/desktop", worktree: "/w/a"),
    ])
    #expect(cards.count == 2)
    #expect(cards[0].apps.count == 2)
    #expect(cards[1].apps.map(\.workspace.path) == ["/w/b/apps/mobile"])
  }

  func devices(_ path: String, worktree: String, body: String) throws -> Workspace {
    try JSONDecoder().decode(
      Workspace.self,
      from: Data(
        "{\"path\":\"\(path)\",\"live\":true,\"warnings\":[],\"worktree\":{\"path\":\"\(worktree)\"},\(body)}".utf8))
  }

  let macosApp = """
    "macos":{"launchId":"m","product":"Stim","bundle":"/S.app","bundleId":"dev.s","executable":"/S.app/S",
      "state":"running","build":{"state":"ok","startedAt":"2026-10-05T09:00:00.000Z"}}
    """
  let ios = #""ios":{"udid":"i","name":"iPhone 17","owned":false,"state":"Booted"}"#
  let android = #""android":{"name":"Pixel","owned":true,"physical":false,"state":"detected","deviceProfile":"pixel_9"}"#

  @Test func offersEachAppsDevicesThenItsMacAppAndLabelsThemByAppOnlyWhenThereAreSeveral() throws {
    let single = WallCard.cards(environments: [try devices("/w/a", worktree: "/w/a", body: "\(android),\(ios),\(macosApp)")])[0]
    #expect(single.options.map(\.label) == ["iPhone 17", "Pixel 9", "Mac app"])
    #expect(single.options.map(\.id) == ["/w/a|ios:i", "/w/a|android:default:Pixel", "/w/a|macos"])

    let several = WallCard.cards(environments: [
      try devices("/w/a/apps/mobile", worktree: "/w/a", body: "\(ios),\(android)"),
      try devices("/w/a/apps/desktop", worktree: "/w/a", body: macosApp),
    ])[0]
    #expect(
      several.options.map(\.label) == [
        "apps/desktop \u{00B7} Mac app", "apps/mobile \u{00B7} iPhone 17", "apps/mobile \u{00B7} Pixel 9",
      ])
  }

  @Test func streamsTheFirstOptionUnlessARememberedChoiceIsStillOffered() throws {
    let card = WallCard.cards(environments: [try devices("/w/a", worktree: "/w/a", body: "\(android),\(ios)")])[0]
    #expect(card.selected(choice: nil)?.label == "iPhone 17")
    #expect(card.selected(choice: "/w/a|android:default:Pixel")?.label == "Pixel 9")
    #expect(card.selected(choice: "/w/a|ios:gone")?.label == "iPhone 17")
  }

  @Test func offersNothingToStreamForAWorkspaceWithoutDevices() throws {
    let card = WallCard.cards(environments: [try devices("/w/a", worktree: "/w/a", body: #""supervisor":{"healthy":true}"#)])[0]
    #expect(card.options.isEmpty)
    #expect(card.selected(choice: nil) == nil)
  }
}
