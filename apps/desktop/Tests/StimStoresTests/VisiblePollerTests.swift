import Foundation
import Testing

@testable import StimStores

@MainActor
private final class Sleeps {
  private var waiting: [CheckedContinuation<Void, Never>] = []
  var pending: Int { waiting.count }

  func sleep() async {
    await withCheckedContinuation { waiting.append($0) }
  }

  func wake() {
    waiting.removeFirst().resume()
  }
}

@MainActor
private final class Harness {
  var visible = false
  var ticks = 0
  let sleeps = Sleeps()
  lazy var poller = VisiblePoller(
    interval: .seconds(3), isVisible: { [unowned self] in visible }, sleep: { [sleeps] _ in await sleeps.sleep() },
    tick: { [unowned self] in ticks += 1 })
}

@MainActor
struct VisiblePollerTests {
  @Test func ticksOnlyWhileVisibleAndAtOnceWhenItBecomesVisible() async {
    let h = Harness()
    h.poller.update()
    await settle()
    #expect(h.ticks == 0)
    #expect(h.sleeps.pending == 0)

    h.visible = true
    h.poller.update()
    h.poller.update()
    #expect(h.ticks == 1)
    #expect(await until { h.sleeps.pending == 1 })
    h.sleeps.wake()
    #expect(await until { h.ticks == 2 && h.sleeps.pending == 1 })

    h.visible = false
    h.poller.update()
    h.sleeps.wake()
    await settle()
    #expect(h.ticks == 2)
    #expect(h.sleeps.pending == 0)

    h.visible = true
    h.poller.update()
    #expect(h.ticks == 3)
    #expect(await until { h.sleeps.pending == 1 })
  }

  @Test func aTickThatFindsItHiddenStopsUntilTheNextUpdate() async {
    let h = Harness()
    h.visible = true
    h.poller.update()
    #expect(await until { h.sleeps.pending == 1 })

    h.visible = false
    h.sleeps.wake()
    await settle()
    #expect(h.ticks == 1)
    #expect(h.sleeps.pending == 0)

    h.visible = true
    h.poller.update()
    #expect(h.ticks == 2)
    #expect(await until { h.sleeps.pending == 1 })
  }
}
