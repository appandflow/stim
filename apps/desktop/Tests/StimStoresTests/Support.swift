import Foundation

final class Scripted<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var waiting: [CheckedContinuation<Value, any Error>] = []

  var calls: Int { lock.withLock { waiting.count } }

  func call() async throws -> Value {
    try await withCheckedThrowingContinuation { continuation in
      lock.withLock { waiting.append(continuation) }
    }
  }

  func finish(_ call: Int, _ result: Result<Value, any Error>) {
    lock.withLock { waiting[call] }.resume(with: result)
  }
}

struct Failed: Error, LocalizedError {
  var errorDescription: String? { "scripted failure" }
}

@MainActor
func until(_ condition: @MainActor () -> Bool) async -> Bool {
  for _ in 0..<400 {
    if condition() { return true }
    try? await Task.sleep(nanoseconds: 5_000_000)
  }
  return condition()
}

@MainActor
func settle() async {
  try? await Task.sleep(nanoseconds: 150_000_000)
}
