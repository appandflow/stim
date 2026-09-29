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
}
