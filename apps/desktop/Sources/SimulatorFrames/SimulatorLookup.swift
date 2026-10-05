import Foundation

struct SimulatorLookupState {
  enum Phase {
    case idle, connecting, failed
  }

  private struct Attempt {
    let id: UUID
    var timedOut = false
  }

  private var attempts: [String: Attempt] = [:]

  func phase(udid: String) -> Phase {
    guard let attempt = attempts[udid] else { return .idle }
    return attempt.timedOut ? .failed : .connecting
  }

  mutating func begin(udid: String, id: UUID) -> Bool {
    guard attempts[udid] == nil else { return false }
    attempts[udid] = Attempt(id: id)
    return true
  }

  mutating func timeout(udid: String, id: UUID) -> Bool {
    guard let attempt = attempts[udid], attempt.id == id, !attempt.timedOut else { return false }
    attempts[udid]?.timedOut = true
    return true
  }

  mutating func finish(udid: String, id: UUID) -> Bool {
    guard let attempt = attempts[udid], attempt.id == id else { return false }
    attempts[udid] = nil
    return !attempt.timedOut
  }
}

@MainActor
enum SimulatorLookup {
  private static var state = SimulatorLookupState()

  enum Failure: LocalizedError {
    case busy, timeout, unavailable

    var errorDescription: String? {
      switch self {
      case .busy: return "The simulator is still connecting."
      case .timeout: return "The simulator did not respond. Input is unavailable until it responds."
      case .unavailable: return "The simulator's input service is unavailable."
      }
    }
  }

  static func run<Value>(udid: String, operation: @escaping () throws -> Value) async throws -> Value {
    try Task.checkCancellation()
    let id = UUID()
    guard state.begin(udid: udid, id: id) else {
      throw state.phase(udid: udid) == .failed ? Failure.timeout : Failure.busy
    }
    return try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.global(qos: .userInitiated).async {
        let result = Result(catching: operation)
        DispatchQueue.main.async {
          if state.finish(udid: udid, id: id) { continuation.resume(with: result) }
        }
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
        // CoreSimulator's synchronous XPC lookup keeps its thread until the reply, even after our timeout.
        if state.timeout(udid: udid, id: id) { continuation.resume(throwing: Failure.timeout) }
      }
    }
  }
}
