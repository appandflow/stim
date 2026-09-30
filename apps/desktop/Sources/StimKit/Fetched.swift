import Foundation

/// A command's last successful result, and the error of the run after it when that run failed.
public struct Fetched<Value: Sendable>: Sendable {
  public private(set) var value: Value?
  public private(set) var error: String?

  public init() {}

  public mutating func record(_ result: Result<Value, any Error>) {
    switch result {
    case .success(let value):
      self.value = value
      error = nil
    case .failure(let failure):
      error = failure.localizedDescription
    }
  }
}
