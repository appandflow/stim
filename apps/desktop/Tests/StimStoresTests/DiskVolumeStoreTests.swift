import Foundation
import StimKit
import Testing

@testable import StimStores

@MainActor
private final class Clock {
  var date = Date(timeIntervalSince1970: 1_000_000)
  func advance(_ seconds: TimeInterval) { date = date.addingTimeInterval(seconds) }
}

private func volume(_ name: String) -> [DiskVolume] {
  [DiskVolume(id: name, name: name, availableBytes: 1, totalBytes: 2, holds: ["Stim home"])]
}

@MainActor
private func store(_ probes: Scripted<[DiskVolume]>, _ clock: Clock) -> DiskVolumeStore {
  DiskVolumeStore(
    locations: { [(label: "Stim home", path: "/stim")] }, probe: { _ in (try? await probes.call()) ?? [] },
    now: { clock.date })
}

@MainActor
struct DiskVolumeStoreTests {
  @Test func readersWithinMaxAgeShareOneProbeAndAnOlderOneProbesAgain() async {
    let clock = Clock()
    let probes = Scripted<[DiskVolume]>()
    let disks = store(probes, clock)
    let metrics = Task { await disks.volumes(maxAge: 1) }
    #expect(await until { probes.calls == 1 })
    let oversight = Task { await disks.volumes(maxAge: 15) }
    await settle()
    #expect(probes.calls == 1)
    probes.finish(0, .success(volume("one")))
    #expect(await metrics.value == volume("one"))
    #expect(await oversight.value == volume("one"))

    clock.advance(10)
    #expect(await disks.volumes(maxAge: 30) == volume("one"))
    #expect(probes.calls == 1)

    let stale = Task { await disks.volumes(maxAge: 1) }
    #expect(await until { probes.calls == 2 })
    probes.finish(1, .success(volume("two")))
    #expect(await stale.value == volume("two"))
  }

  @Test func aZeroMaxAgeSkipsAProbeThatStartedEarlierAndKeepsTheNewerResult() async {
    let clock = Clock()
    let probes = Scripted<[DiskVolume]>()
    let disks = store(probes, clock)
    let tick = Task { await disks.volumes(maxAge: 30) }
    #expect(await until { probes.calls == 1 })

    clock.advance(1)
    let afterCleanup = Task { await disks.volumes(maxAge: 0) }
    #expect(await until { probes.calls == 2 })
    probes.finish(1, .success(volume("after")))
    #expect(await afterCleanup.value == volume("after"))
    probes.finish(0, .success(volume("before")))
    #expect(await tick.value == volume("before"))

    #expect(await disks.volumes(maxAge: 30) == volume("after"))
    #expect(probes.calls == 2)
  }
}
