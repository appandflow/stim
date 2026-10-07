import XCTest

@testable import StimDesktop

@MainActor final class CopyFeedbackTests: XCTestCase {
  private final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var waiters: [CheckedContinuation<Void, Error>] = []
    private(set) var requested: [Duration] = []

    var pending: Int { lock.withLock { waiters.count } }

    func sleep(_ duration: Duration) async throws {
      try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
          lock.withLock {
            requested.append(duration)
            waiters.append(continuation)
          }
        }
      } onCancel: {
        let cancelled = lock.withLock { () -> [CheckedContinuation<Void, Error>] in
          let all = waiters
          waiters = []
          return all
        }
        for waiter in cancelled { waiter.resume(throwing: CancellationError()) }
      }
    }

    func elapse() {
      let due = lock.withLock { () -> [CheckedContinuation<Void, Error>] in
        let all = waiters
        waiters = []
        return all
      }
      for waiter in due { waiter.resume() }
    }
  }

  private func settle() async {
    for _ in 0..<20 { await Task.yield() }
  }

  func testRevertsToCopyAfterTheDelay() async {
    let clock = Clock()
    let feedback = CopyFeedback(sleep: clock.sleep)
    XCTAssertFalse(feedback.copied)
    feedback.didCopy()
    await settle()
    XCTAssertTrue(feedback.copied)
    XCTAssertEqual(clock.requested, [.seconds(2)])
    clock.elapse()
    await settle()
    XCTAssertFalse(feedback.copied)
  }

  func testRepeatCopyRestartsTheWaitWithoutStackingReverts() async {
    let clock = Clock()
    let feedback = CopyFeedback(sleep: clock.sleep)
    feedback.didCopy()
    await settle()
    feedback.didCopy()
    await settle()
    XCTAssertEqual(clock.requested.count, 2)
    XCTAssertEqual(clock.pending, 1)
    XCTAssertTrue(feedback.copied)
    clock.elapse()
    await settle()
    XCTAssertFalse(feedback.copied)
  }
}
