import Foundation
import Testing

@testable import StimKit

@Suite struct SharedWorkspaceLinkTests {
  let home = "871c7262-f6bc-469a-b822-15da928350ee"
  let workspace = "0123456789abcdef"

  @Test func parsesOnlyUnambiguousClaimedDestinations() throws {
    let link = "https://stim.appandflow.com/open?v=1&machine=\(home)&workspace=\(workspace)&platform=macos&slot=tablet%20b"
    let request = try #require(sharedWorkspaceRequest(from: URL(string: link)!))
    #expect(request.machine == home && request.workspace == workspace)
    #expect(request.platform == "macos" && request.slot == "tablet b")
    let formEncoded = link.replacingOccurrences(of: "tablet%20b", with: "tablet+b%2Bc")
    #expect(sharedWorkspaceRequest(from: URL(string: formEncoded)!)?.slot == "tablet b+c")
    #expect(workspaceLink(fromOpenURL: URL(string: link)!) == .shared(request))
    #expect(
      sharedWorkspaceRequest(
        from: URL(string: link.replacingOccurrences(of: "https://stim.appandflow.com/open", with: "stim-desktop://shared"))!)
        == request)
    for invalid in [
      link.replacingOccurrences(of: "https:", with: "http:"),
      link.replacingOccurrences(of: "stim.appandflow.com", with: "evil.example"),
      link.replacingOccurrences(of: "https://", with: "https://user@"),
      link.replacingOccurrences(of: "v=1", with: "v=2"),
      link + "&machine=\(home)", link + "&slot=other",
      link.replacingOccurrences(of: "platform=macos", with: "platform=tvos"),
    ] {
      #expect(sharedWorkspaceRequest(from: URL(string: invalid)!) == nil)
    }
  }

  @Test func resolvesOpaqueIDsOnlyOnTheAuthenticatedHome() throws {
    let fixture = Bundle.module.url(forResource: "status", withExtension: "json", subdirectory: "Fixtures")!
    var status = try JSONDecoder().decode(StatusPayload.self, from: Data(contentsOf: fixture))
    status.environments[0].workspaceId = workspace
    let request = SharedWorkspaceOpenRequest(machine: home, workspace: workspace, platform: "ios", slot: "ipad")
    let found = try #require(status.request(for: request, homeId: home))
    #expect(found.path == status.environments[0].path && found.platform == "ios" && found.slot == "ipad")
    #expect(status.request(for: request, homeId: "61d025cb-e23c-434d-8e47-88db533811eb") == nil)
    status.environments.removeFirst()
    #expect(status.request(for: request, homeId: home) == nil)
  }
}
