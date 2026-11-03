import Testing

@testable import StimKit

@Suite struct UpdateChannelTests {
  @Test func stableUpdatesAllowNoPrereleaseChannel() {
    #expect(UpdateChannel.allowed(prereleaseUpdates: false).isEmpty)
    #expect(UpdateChannel.allowed(prereleaseUpdates: true) == ["next"])
  }

  @Test func onlyANextBuildStartsOptedIn() {
    #expect(UpdateChannel.prereleaseUpdatesDefault(bundleVersion: "0.3.0-next.20261103170000.gabc1234"))
    #expect(!UpdateChannel.prereleaseUpdatesDefault(bundleVersion: "0.2.16"))
    #expect(!UpdateChannel.prereleaseUpdatesDefault(bundleVersion: "0.3.0-rc.1"))
    #expect(!UpdateChannel.prereleaseUpdatesDefault(bundleVersion: nil))
  }
}
