/// The payload printed by `stim stats --json` inside a workspace.
public struct ProjectStats: Decodable, Sendable {
  public struct Platform: Decodable, Sendable {
    public var runs: Int
    public var failed: Int
    public var hits: Int
    public var misses: Int
    public var timeSavedMs: Double?
    public var lastColdBuildMs: Double?

    public var hitRate: Double {
      let lookups = hits + misses
      return lookups == 0 ? 0 : Double(hits) / Double(lookups)
    }
  }

  public struct Scope: Decodable, Sendable {
    public var ios: Platform?
    public var android: Platform?
  }

  public var project: Scope?
}
