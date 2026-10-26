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

  @Test func refetchesACacheTheInstalledStimHasOvertaken() {
    let now = Date(timeIntervalSince1970: 1_000_000)
    let installed = SemanticVersion("1.24.0")!
    let cached = SemanticVersion("1.23.1")!
    let recent = now.addingTimeInterval(-StimRelease.staleRetryInterval)
    #expect(StimRelease.isDue(lastChecked: recent, now: now, installed: installed, cachedLatest: cached))
    #expect(!StimRelease.isDue(lastChecked: recent, now: now, installed: cached, cachedLatest: cached))
    #expect(!StimRelease.isDue(lastChecked: recent, now: now, installed: cached, cachedLatest: installed))
  }

  @Test func throttlesTheRefetchWhileTheInstalledStimStaysAheadOfTheRegistry() {
    let now = Date(timeIntervalSince1970: 1_000_000)
    let installed = SemanticVersion("1.25.0-rc.1")!
    let cached = SemanticVersion("1.24.0")!
    let justChecked = now.addingTimeInterval(-60)
    #expect(!StimRelease.isDue(lastChecked: justChecked, now: now, installed: installed, cachedLatest: cached))
  }
}

@Suite struct StimReleaseShownLatestTests {
  @Test func neverShowsALatestBelowTheInstalledStim() {
    let installed = SemanticVersion("1.24.0")!
    #expect(StimRelease.shownLatest(installed: installed, latest: SemanticVersion("1.23.1")) == nil)
    #expect(StimRelease.shownLatest(installed: SemanticVersion("1.25.0-rc.1")!, latest: installed) == nil)
  }

  @Test func showsALatestAtOrAboveTheInstalledStim() {
    let installed = SemanticVersion("1.24.0")!
    #expect(StimRelease.shownLatest(installed: installed, latest: installed) == installed)
    #expect(StimRelease.shownLatest(installed: installed, latest: SemanticVersion("1.25.0")) == SemanticVersion("1.25.0"))
    #expect(StimRelease.shownLatest(installed: installed, latest: nil) == nil)
  }
}
