import Foundation

struct SimulatorLookupState {
  enum Phase {
    case idle, connecting, failed
  }

  private struct Attempt {
    let id: UUID
    var timedOut = false
    var waiting = true
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
    attempts[udid]?.waiting = false
    return attempt.waiting
  }

  mutating func cancel(udid: String, id: UUID) -> Bool {
    guard let attempt = attempts[udid], attempt.id == id, attempt.waiting else { return false }
    attempts[udid]?.waiting = false
    return true
  }

  mutating func finish(udid: String, id: UUID) -> Bool {
    guard let attempt = attempts[udid], attempt.id == id else { return false }
    attempts[udid] = nil
    return attempt.waiting
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
    try await wait(udid: udid) { completion in
      DispatchQueue.global(qos: .userInitiated).async {
        completion(Result(catching: operation))
      }
    }
  }

  fileprivate static func runAsync<Value>(udid: String, operation: @escaping () async throws -> Value) async throws -> Value {
    try await wait(udid: udid) { completion in
      Task.detached {
        do {
          completion(.success(try await operation()))
        } catch {
          completion(.failure(error))
        }
      }
    }
  }

  private static func wait<Value>(
    udid: String, start: (@escaping (Result<Value, Error>) -> Void) -> Void
  ) async throws -> Value {
    try Task.checkCancellation()
    let id = UUID()
    guard state.begin(udid: udid, id: id) else {
      throw state.phase(udid: udid) == .failed ? Failure.timeout : Failure.busy
    }
    var cancelWait: (@MainActor () -> Void)?
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        cancelWait = {
          if state.cancel(udid: udid, id: id) { continuation.resume(throwing: CancellationError()) }
        }
        if Task.isCancelled { cancelWait?() }
        start { result in
          DispatchQueue.main.async {
            if state.finish(udid: udid, id: id) { continuation.resume(with: result) }
          }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
          // CoreSimulator's synchronous XPC lookup keeps its thread until the reply, even after our timeout.
          if state.timeout(udid: udid, id: id) { continuation.resume(throwing: Failure.timeout) }
        }
      }
    } onCancel: {
      Task { @MainActor in cancelWait?() }
    }
  }
}

extension SimulatorRotation {
  public static func rotateBounded(udid: String, clockwise: Bool) async -> Bool {
    (try? await SimulatorLookup.run(udid: udid) { rotate(udid: udid, clockwise: clockwise) }) ?? false
  }
}

extension SimulatorDevelopmentOptions {
  public static func readBounded(udid: String) async throws -> Settings {
    try await SimulatorLookup.run(udid: udid) { try read(udid: udid) }
  }

  public static func setSlowAnimationsBounded(_ enabled: Bool, udid: String) async throws -> Settings {
    try await SimulatorLookup.run(udid: udid) { try setSlowAnimations(enabled, udid: udid) }
  }

  public static func shakeBounded(udid: String) async throws -> Settings {
    try await SimulatorLookup.run(udid: udid) {
      try shake(udid: udid)
      return try read(udid: udid)
    }
  }
}

extension SimulatorPosture {
  public static func isAvailableBounded(udid: String) async -> Bool {
    (try? await SimulatorLookup.run(udid: udid) { isAvailable(udid: udid) }) ?? false
  }

  public static func moveBounded(udid: String, from angle: Double, to target: Double) async -> String? {
    do {
      return try await SimulatorLookup.runAsync(udid: udid) { await move(udid: udid, from: angle, to: target) }
    } catch {
      return error.localizedDescription
    }
  }
}
