import Foundation
import Testing

@testable import StimKit

@Suite struct MemoryReclaimTests {
  let watchman = MachineOwner(kind: .shared, name: "Watchman", memoryMb: 4250)
  let gradle = MachineOwner(kind: .shared, name: "Gradle daemon", memoryMb: 700)
  let kotlin = MachineOwner(kind: .shared, name: "Kotlin daemon", memoryMb: 350)

  func report(_ sections: String) throws -> GcReport {
    try JSONDecoder().decode(GcReport.self, from: Data(#"{"sections":{\#(sections)}}"#.utf8))
  }

  @Test func offersTheShutdownWhenGcProvesWatchmanUnused() throws {
    let gc = try report(
      """
      "memory":[{"kind":"watchman","cacheKind":"watchman","pid":41,"bytes":4456448000,"state":"idle","reclaimable":true,"reason":null,"detail":null}],
      "watchmanRoots":[{"path":"/gone","stale":"missing","subscriptions":0,"triggers":0,"removable":true,"detail":"directory is gone"}],
      "memoryNotices":[]
      """)
    let offer = try #require(GcReport.reclaim(for: watchman, in: gc))
    #expect(offer.isAvailable && offer.title == "Reclaim memory" && offer.stops == 1)
    #expect(offer.consequence.hasPrefix("Shuts down the watchman daemon to free "))
    #expect(offer.bytes == 4_456_448_000 && offer.staleRoots == 1)
    #expect(offer.command(cwd: "/h") == StimCommand(["gc", "--delete", "--json", "--cache", "watchman"], cwd: "/h"))
  }

  @Test func namesWhoUsesWatchmanWhenGcKeepsIt() throws {
    let gc = try report(
      """
      "memory":[{"kind":"watchman","cacheKind":"watchman","pid":41,"bytes":4456448000,"state":"busy","reclaimable":false,"reason":"in-use","detail":"used by Metro in /w/app"}],
      "watchmanRoots":[{"path":"/w/app","stale":null,"subscriptions":1,"triggers":0,"removable":false,"detail":null}]
      """)
    let offer = try #require(GcReport.reclaim(for: watchman, in: gc))
    #expect(!offer.isAvailable)
    #expect(offer.unavailableReason == "Kept: used by Metro in /w/app")
  }

  @Test func offersOnlyStaleRootRemovalWhenTheDaemonStays() throws {
    let gc = try report(
      """
      "memory":[{"kind":"watchman","cacheKind":"watchman","pid":41,"bytes":4456448000,"state":"busy","reclaimable":false,"reason":"in-use","detail":"used by Metro"}],
      "watchmanRoots":[{"path":"/gone","stale":"pruned-worktree","subscriptions":0,"triggers":0,"removable":true,"detail":"pruned"}]
      """)
    let offer = try #require(GcReport.reclaim(for: watchman, in: gc))
    #expect(offer.isAvailable)
    #expect(offer.stops == 0 && offer.title == "Remove stale roots")
    #expect(offer.consequence.hasPrefix("Removes 1 stale watchman root."))
    #expect(offer.keptReasons == ["used by Metro"])
  }

  @Test func sumsTheIdleDaemonsAndListsWhyOthersStay() throws {
    let gc = try report(
      """
      "memory":[
        {"kind":"gradleDaemon","cacheKind":"gradle-daemons","pid":1,"bytes":300,"state":"idle","reclaimable":true},
        {"kind":"gradleDaemon","cacheKind":"gradle-daemons","pid":2,"bytes":400,"state":"idle","reclaimable":true},
        {"kind":"gradleDaemon","cacheKind":"gradle-daemons","pid":3,"bytes":500,"state":"busy","reclaimable":false,"reason":"busy","detail":"a build is using it"},
        {"kind":"kotlinDaemon","cacheKind":"gradle-daemons","pid":4,"bytes":350,"state":"unknown","reclaimable":false,"reason":"unknown","detail":"a Gradle daemon is busy or its state is unknown"}
      ]
      """)
    let gradleOffer = try #require(GcReport.reclaim(for: gradle, in: gc))
    #expect(gradleOffer.isAvailable)
    #expect(gradleOffer.bytes == 1050 && gradleOffer.stops == 3 && gradleOffer.cacheKind == "gradle-daemons")
    #expect(gradleOffer.keptReasons == ["a build is using it"])
    #expect(GcReport.reclaim(for: kotlin, in: gc) == gradleOffer)
  }

  @Test func stillOffersTheStopWhenGcReportsNoSize() throws {
    let gc = try report(#""memory":[{"kind":"watchman","cacheKind":"watchman","pid":41,"bytes":null,"reclaimable":true}]"#)
    let offer = try #require(GcReport.reclaim(for: watchman, in: gc))
    #expect(offer.stops == 1 && offer.bytes == 0 && offer.title == "Reclaim memory")
    #expect(offer.consequence.hasPrefix("Shuts down the watchman daemon."))
  }

  @Test func explainsAnEmptyOrMissingReport() throws {
    #expect(GcReport.reclaim(for: watchman, in: nil)?.isAvailable == false)
    let old = try #require(GcReport.reclaim(for: watchman, in: try report(#""caches":[]"#)))
    #expect(old.unavailableReason == "This stim does not report memory it can reclaim. Update stim.")
    let skipped = try report(#""memory":[],"memoryNotices":[{"message":"skipped: STIM_HOME is set"}]"#)
    #expect(GcReport.reclaim(for: watchman, in: skipped)?.unavailableReason == "skipped: STIM_HOME is set")
    #expect(GcReport.reclaim(for: MachineOwner(kind: .shared, name: "adb server"), in: skipped) == nil)
    #expect(GcReport.reclaim(for: MachineOwner(kind: .metro, name: "Watchman"), in: skipped) == nil)
  }
}
