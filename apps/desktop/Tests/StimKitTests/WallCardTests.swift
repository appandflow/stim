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
}
