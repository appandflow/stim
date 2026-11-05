import Foundation
import Testing

@testable import StimKit

@Suite struct ProjectsTests {
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
