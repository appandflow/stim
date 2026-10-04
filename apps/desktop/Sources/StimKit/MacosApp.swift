import Foundation

/// The Swift Package development app recorded by `stim macos`.
public struct MacosApp: Decodable, Hashable, Sendable {
  public var launchId: String
  public var product: String
  public var bundle: String
  public var bundleId: String
  public var executable: String
  public var state: String
  public var app: Process?
  public var build: Build

  public struct Process: Decodable, Hashable, Sendable {
    public var pid: Int32
    public var startedAtMicros: UInt64
  }

  public struct Build: Decodable, Hashable, Sendable {
    public var state: String
    public var startedAt: String
    public var finishedAt: String?
    public var durationMs: Double?
    public var error: String?
  }
}
