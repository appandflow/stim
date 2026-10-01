import Foundation
import Testing

@testable import StimKit

private func compatible(_ version: String) -> CLICompatibility { .compatible(SemanticVersion(version)!) }
private let latest = SemanticVersion("1.14.0")!

@Suite struct StimReleaseOfferTests {
  @Test func offersTheLatestToAnOlderStimThatAManagerOwns() {
    #expect(StimRelease.offer(installed: compatible("1.12.0"), latest: latest, owner: .pnpm) == latest)
  }

  @Test func neverOffersAnUpdateToAStimNoManagerOwns() {
    #expect(StimRelease.offer(installed: compatible("1.12.0"), latest: latest, owner: nil) == nil)
  }

  @Test func offersNothingToACurrentOrNewerStim() {
    #expect(StimRelease.offer(installed: compatible("1.14.0"), latest: latest, owner: .npm) == nil)
    #expect(StimRelease.offer(installed: compatible("1.15.0-rc.1"), latest: latest, owner: .npm) == nil)
  }

  @Test func offersNothingWithoutAnAnswerOrAReadableInstall() {
    #expect(StimRelease.offer(installed: compatible("1.12.0"), latest: nil, owner: .npm) == nil)
    #expect(StimRelease.offer(installed: .outdated(found: "1.9.0"), latest: latest, owner: .npm) == nil)
    #expect(StimRelease.offer(installed: .missing, latest: latest, owner: .npm) == nil)
    #expect(StimRelease.offer(installed: nil, latest: latest, owner: .npm) == nil)
  }
}

@Suite struct StimReleaseRegistryTests {
  @Test func readsTheVersionOfALatestManifest() {
    let body = Data(#"{"name":"stim","version":"1.14.0","dist":{"tarball":"x"}}"#.utf8)
    #expect(StimRelease.latest(in: body) == latest)
  }

  @Test func ignoresABodyThatIsNotAManifest() {
    #expect(StimRelease.latest(in: Data(#"{"error":"Not found"}"#.utf8)) == nil)
    #expect(StimRelease.latest(in: Data("<html>".utf8)) == nil)
  }

  @Test func checksOnceADayAndAfterAClockMovesBack() {
    let now = Date(timeIntervalSince1970: 1_000_000)
    #expect(StimRelease.isDue(lastChecked: nil, now: now))
    #expect(!StimRelease.isDue(lastChecked: now.addingTimeInterval(-3600), now: now))
    #expect(StimRelease.isDue(lastChecked: now.addingTimeInterval(-86400), now: now))
    #expect(StimRelease.isDue(lastChecked: now.addingTimeInterval(3600), now: now))
  }
}
