import Foundation
import Testing

@testable import StimKit

@Suite struct ProjectsTests {
  @Test(
    arguments: [
      ("https://github.com/janicduplessis/expo.git", "janicduplessis/expo"),
      ("https://github.com/janicduplessis/expo", "janicduplessis/expo"),
      ("https://x-access-token:abc123@github.com/Janic/Expo.git", "janic/expo"),
      ("git@github.com:janicduplessis/expo.git", "janicduplessis/expo"),
      ("ssh://git@github.com/janicduplessis/expo.git", "janicduplessis/expo"),
      ("https://github.com/janicduplessis/expo.git/", "janicduplessis/expo"),
      ("github-work:janicduplessis/expo.git", "janicduplessis/expo"),
    ])
  func parsesOwnerAndNameOutOfARemoteURL(url: String, repo: String) {
    #expect(parseRemoteRepo(url) == repo)
  }

  @Test(arguments: ["not-a-url", "", "https://github.com/onlyowner"])
  func rejectsWhatDoesNotLookLikeARemoteURL(url: String) {
    #expect(parseRemoteRepo(url) == nil)
  }

  @Test func titlesAreFolderNamesUnlessTwoProjectsShareOne() {
    let titles = projectTitles(roots: ["/w/code/app", "/w/work/app", "/w/code/other"])
    #expect(titles["/w/code/app"] == "app (code)")
    #expect(titles["/w/work/app"] == "app (work)")
    #expect(titles["/w/code/other"] == "other")
  }

  @Test func titlesAddEnclosingFoldersUntilProjectsDifferAcrossUnequalDepths() {
    let titles = projectTitles(roots: ["/a/x/app", "/b/x/app", "/app"])
    #expect(titles["/a/x/app"] == "app (a/x)")
    #expect(titles["/b/x/app"] == "app (b/x)")
    #expect(titles["/app"] == "app")
  }
}
