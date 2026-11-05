import Foundation
import Testing

@testable import StimKit

@MainActor
private final class Clock {
  var isActive = true
  var ticks = 0
  var slept: [Duration] = []
  private var waiting: [Int: CheckedContinuation<Void, Never>] = [:]
  private var nextID = 0

  func sleep(_ duration: Duration) async {
    slept.append(duration)
    let id = nextID
    nextID += 1
    await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        if Task.isCancelled { continuation.resume() } else { waiting[id] = continuation }
      }
    } onCancel: {
      Task { @MainActor in self.waiting.removeValue(forKey: id)?.resume() }
    }
  }

  func wake() {
    let all = waiting.values
    waiting = [:]
    for continuation in all { continuation.resume() }
  }

  func settle() async {
    for _ in 0..<20 { await Task.yield() }
  }

  func poller() -> ActivityPoller {
    ActivityPoller(
      active: .seconds(10), inactive: .seconds(60), isActive: { self.isActive },
      sleep: { await self.sleep($0) }, tick: { self.ticks += 1 })
  }
}

@MainActor
@Suite struct ActivityPollerTests {
  @Test func pollsSlowlyWhileInactiveAndAtOnceOnActivation() async {
    let clock = Clock()
    clock.isActive = false
    let poller = clock.poller()
    poller.start()
    await clock.settle()
    #expect(clock.slept == [.seconds(60)])
    #expect(clock.ticks == 0)

    clock.isActive = true
    poller.activate()
    await clock.settle()
    #expect(clock.ticks == 1)
    #expect(clock.slept.last == .seconds(10))

    clock.wake()
    await clock.settle()
    #expect(clock.ticks == 2)
    #expect(clock.slept.last == .seconds(10))

    clock.isActive = false
    clock.wake()
    await clock.settle()
    #expect(clock.ticks == 3)
    #expect(clock.slept.last == .seconds(60))
  }

  @Test func activationBeforeStartDoesNothing() async {
    let clock = Clock()
    let poller = clock.poller()
    poller.activate()
    await clock.settle()
    #expect(clock.ticks == 0)
    #expect(clock.slept.isEmpty)
  }
}
